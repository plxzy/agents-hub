#!/usr/bin/env node
// Local stdio MCP server that lets other apps (Claude Code/Desktop, Codex, ChatGPT via a local bridge) use the
// agents in AGENT_HOME through the same code as the `agent` CLI. Dependency-free JSON-RPC over stdio.
import path from 'node:path';
import { STATE, getAgent, listRuns, loadAgents, runAgent } from './agent.mjs';
import { acceptProposal, pending, recordFeedback, rejectProposal, runEvals } from './improve.mjs';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const brief = (r) => ({
  run_id: r.run_id, agent: r.agent, kind: r.kind ?? 'task', status: r.status, task: r.task, started: r.started,
  model: r.model, tool_calls: r.tool_calls?.length ?? 0, blocked: r.blocked?.length ?? 0, tokens: r.usage?.totalTokens,
  cost_usd: r.usage?.cost, feedback: r.feedback?.rating ?? null,
});

const TOOLS = [
  {
    name: 'list_agents',
    description: "List the user's agents (name, what it is for, tools, skills, guard, workspace).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: () => text(loadAgents().map((a) => ({ name: a.name, description: a.description, model: a.model, tools: a.tools,
      skills: Array.isArray(a.skills) ? a.skills.map((s) => s.split('/').pop()) : a.skills, guard: a.guard, workspace: a.workspace }))),
  },
  {
    name: 'run_agent',
    description: 'Ask one of the user\'s agents to do a task and return its answer. The agent runs locally in Pi with its own '
      + 'instructions, tools, guard and reviewed memory. Pass the user\'s request as the task, in their words. '
      + 'For workspace: here agents, pass your project folder as an absolute cwd; otherwise the server\'s current folder is used. '
      + 'cwd is an error for other agents. Use continue=true to follow up in the same agent conversation in that folder. Takes seconds to a few minutes.',
    inputSchema: { type: 'object', required: ['agent', 'task'], additionalProperties: false, properties: {
      agent: { type: 'string', description: 'Agent name from list_agents' },
      task: { type: 'string', description: 'What to ask the agent' },
      cwd: { type: 'string', description: 'Absolute project folder, only for workspace: here agents' },
      continue: { type: 'boolean', description: 'Continue the agent\'s previous conversation', default: false },
    } },
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async ({ agent, task, cwd, continue: resume = false }) => {
      const definition = getAgent(agent);
      if (cwd !== undefined) {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
        if (definition.workspace !== 'here') throw new Error('cwd is only allowed for workspace: here agents');
      }
      const r = await runAgent(agent, task, { resume, cwd });
      const answer = (r.output ?? r.error ?? '(no output)').replace(/```remember\n[\s\S]*?```/g, '').trim();
      return text(`${answer}\n\n— run ${r.run_id} · ${r.status} · ${r.model} · ${r.tool_calls.length} tool call(s)`
        + `${r.blocked?.length ? ` · ${r.blocked.length} blocked by guard` : ''} · $${r.usage.cost.toFixed(4)}`
        + `${r.memory_proposed.length ? ` · ${r.memory_proposed.length} memory proposal(s) waiting for the user's review` : ''}`);
    },
  },
  {
    name: 'list_runs',
    description: 'Recent agent runs and chats (newest last), with status, cost and the user\'s rating.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      agent: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    } },
    annotations: { readOnlyHint: true },
    run: ({ agent, limit = 10 }) => text(listRuns(STATE).filter((r) => !agent || r.agent === agent).slice(-limit).map(brief)),
  },
  {
    name: 'get_run',
    description: 'Full record of one run: task, answer, tools and commands used, blocked attempts, memory used and proposed.',
    inputSchema: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    run: ({ run_id }) => {
      const r = listRuns(STATE).find((x) => x.run_id === run_id);
      if (!r) throw new Error(`no run ${run_id}`);
      const { raw_events, transcript, ...rest } = r;
      return text(rest);
    },
  },
  {
    name: 'rate_run',
    description: "Record the USER's rating of a run or chat (good/bad + why). Only pass a rating the user gave; never rate on your own judgment.",
    inputSchema: { type: 'object', required: ['run_id', 'rating'], additionalProperties: false, properties: {
      run_id: { type: 'string', description: 'A run id, or "last"' },
      rating: { type: 'string', enum: ['good', 'bad'] },
      comment: { type: 'string', description: "The user's reason, in their words" },
    } },
    annotations: { readOnlyHint: false, idempotentHint: true },
    run: ({ run_id, rating, comment }) => { const r = recordFeedback(run_id, rating, comment); return text(`rated ${r.run_id} ${rating}`); },
  },
  {
    name: 'list_pending',
    description: 'Proposals waiting for the user: memory notes, test cases, instruction edits (from agents or the coach).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
    run: () => text(pending().map(({ id, kind, agent, why, body }) => ({ id, kind, agent, why, body }))),
  },
  {
    name: 'review_decide',
    description: 'Accept or reject one pending proposal. ONLY when the user explicitly decided this specific proposal; '
      + 'never on your own initiative. Accepting changes the agent and is committed to its version history.',
    inputSchema: { type: 'object', required: ['id', 'decision'], additionalProperties: false, properties: {
      id: { type: 'string' }, decision: { type: 'string', enum: ['accept', 'reject'] }, reason: { type: 'string' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: ({ id, decision, reason }) => text(decision === 'accept' ? `accepted → ${acceptProposal(id)}` : `rejected → ${rejectProposal(id, reason)}`),
  },
  {
    name: 'run_eval',
    description: "Run an agent's test cases and compare the score with its previous version.",
    inputSchema: { type: 'object', required: ['agent'], additionalProperties: false, properties: { agent: { type: 'string' } } },
    annotations: { readOnlyHint: false },
    run: async ({ agent }) => {
      const { report, previous } = await runEvals(agent);
      return text({ agent, version: report.agent_version, passed: `${report.passed}/${report.total}`, cost_usd: report.cost,
        previous: previous ? `${previous.passed}/${previous.total} (v${previous.agent_version})` : null,
        results: report.results.map((r) => ({ question: r.question, pass: r.pass, problems: r.problems, blocked: r.blocked.length })) });
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'agents', version: '0.1.0' },
      instructions: "The user's own agents (Pi, local). Use run_agent to delegate to a matching agent; list_agents shows what exists. "
        + 'Ratings and proposal decisions belong to the user: only pass them on when the user states them.' } });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    try { return send({ jsonrpc: '2.0', id, result: await tool.run(params.arguments ?? {}) }); }
    catch (e) { return send({ jsonrpc: '2.0', id, result: { ...text(`error: ${e.message}`), isError: true } }); }
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
  }
});
