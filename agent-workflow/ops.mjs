// The operations catalog: everything the agent system can do for another app, defined once. The local MCP
// server, the dashboard, `agent call`, the Pi package and (later) the hosted hub are built from this list, so a
// new operation or a change in who may call it is made here only.
//
// access: read (look only) · run (starts agents) · decide (the user's own decisions: ratings, memory, proposals).
// Hosts that render the dashboard can call decide operations from the user's clicks; a remote host gets them only
// as app-only tools, so the model never makes those decisions.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, STATE, assertSandboxAllowed, getAgent, listRuns, loadAgents, newId, resolveWorkspace, runAgent, writeRunningMarker,
} from './agent.mjs';
import { acceptProposal, pending, recordFeedback, rejectProposal, runEvals } from './improve.mjs';
import { DASHBOARD_URI, READ_OPS, lastRunOf, runBrief } from './contract.mjs';
import { doctorHealth } from './doctor.mjs';
import { linkedHub, refreshHubCache, flushOutbox } from './hub.mjs';

export { DASHBOARD_URI };
const AGENT_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent.mjs');

// The shared brief (contract.mjs) plus the full task, which only local surfaces show.
const brief = (r) => ({ ...runBrief(r), task: r.task });

const agentSummary = (a, runs) => ({ name: a.name, description: a.description, model: a.model, tools: a.tools,
  skills: Array.isArray(a.skills) ? a.skills.map((s) => s.split('/').pop()) : a.skills, guard: a.guard,
  workspace: a.workspace, runner: a.runner, last_run: lastRunOf(a.name, runs) });

function validateCwd(definition, cwd) {
  if (cwd === undefined) return;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  if (definition.workspace !== 'here') throw new Error('cwd is only allowed for workspace: here agents');
}

// Runners execute an agent somewhere. Only `local` (Pi on this Mac, sandbox + guard) exists today.
export const RUNNERS = {
  local: {
    run: (name, task, { resume, cwd, root, state }) => runAgent(name, task, { resume, cwd, root, state }),
    /** Starts `agent run` in the background and returns its run id at once; the run writes its own receipt. */
    start: (name, task, { resume, cwd, root, state, remote = false, spawn = nodeSpawn }) => {
      const definition = getAgent(name, root);
      const agent = resolveWorkspace(definition, cwd ?? process.cwd());
      assertSandboxAllowed(agent, `agent run ${name} ${JSON.stringify(task)}`);
      const runId = newId('r');
      fs.mkdirSync(path.join(state, 'runs'), { recursive: true, mode: 0o700 });
      const log = fs.openSync(path.join(state, 'runs', `${runId}.log`), 'a', 0o600);
      const child = spawn(process.execPath, [AGENT_CLI, 'run', '--run-id', runId, ...(resume ? ['--continue'] : []), name, task], {
        cwd: cwd ?? process.cwd(), detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, AGENT_HOME: root, AGENT_WORKFLOW_STATE: state, ...(remote ? { AGENT_REMOTE_RUN: '1' } : {}) },
      });
      child.unref();
      // Written here too, so the run is visible before the child gets going.
      writeRunningMarker(state, { run_id: runId, agent: name, task, workspace: agent.workspace, pid: child.pid });
      return runId;
    },
  },
};

const runnerFor = (definition) => {
  const runner = RUNNERS[definition.runner ?? 'local'];
  if (!runner) throw new Error(`runner ${definition.runner} is not available yet`);
  return runner;
};

const AGENT_ARGS = {
  agent: { type: 'string', description: 'Agent name from list_agents' },
  task: { type: 'string', description: 'What to ask the agent, in the user\'s words' },
  cwd: { type: 'string', description: 'Absolute project folder, only for workspace: here agents' },
  continue: { type: 'boolean', description: 'Continue the agent\'s previous conversation', default: false },
};

export const OPS = [
  // Read operations: names, descriptions, schemas and result shapes are shared with the hosted hub (contract.mjs).
  { name: 'open_dashboard', access: 'read', ...READ_OPS.open_dashboard, run: (_, ctx) => dashboardData(ctx) },
  { name: 'get_status', access: 'read', ...READ_OPS.get_status, run: (_, ctx) => status(ctx) },
  {
    name: 'list_agents', access: 'read', ...READ_OPS.list_agents,
    run: (_, { root, state }) => { const runs = listRuns(state, { running: true }); return loadAgents(root).map((a) => agentSummary(a, runs)); },
  },
  {
    name: 'run_agent', access: 'run', title: 'Run an agent',
    description: 'Ask one of the user\'s agents to do a task and return its answer. The agent runs locally in Pi with its own '
      + 'instructions, tools, guard and reviewed memory. Pass the user\'s request as the task, in their words. '
      + 'For workspace: here agents, pass your project folder as an absolute cwd; otherwise the server\'s current folder is used. '
      + 'cwd is an error for other agents. Use continue=true to follow up in the same agent conversation in that folder. Takes seconds to a few minutes.',
    input: { type: 'object', required: ['agent', 'task'], additionalProperties: false, properties: AGENT_ARGS },
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async ({ agent, task, cwd, continue: resume = false }, { root, state }) => {
      const definition = getAgent(agent, root);
      validateCwd(definition, cwd);
      const r = await runnerFor(definition).run(agent, task, { resume, cwd, root, state });
      const answer = (r.output ?? r.error ?? '(no output)').replace(/```remember\n[\s\S]*?```/g, '').trim();
      return `${answer}\n\n— run ${r.run_id} · ${r.status} · ${r.model} · ${r.tool_calls.length} tool call(s)`
        + `${r.blocked?.length ? ` · ${r.blocked.length} blocked by guard` : ''} · $${r.usage.cost.toFixed(4)}`
        + `${r.memory_proposed.length ? ` · ${r.memory_proposed.length} memory proposal(s) waiting for the user's review` : ''}`;
    },
  },
  {
    name: 'start_run', access: 'run', title: 'Start a run',
    description: 'Start an agent run in the background and return its run_id right away; check it with get_run. '
      + 'Same arguments as run_agent. Use for long tasks or when you should not wait.',
    input: { type: 'object', required: ['agent', 'task'], additionalProperties: false, properties: AGENT_ARGS },
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: ({ agent, task, cwd, continue: resume = false }, { root, state, spawn, remote }) => {
      const definition = getAgent(agent, root);
      validateCwd(definition, cwd);
      const run_id = runnerFor(definition).start(agent, task, { resume, cwd, root, state, spawn, remote });
      return { run_id, status: 'running' };
    },
  },
  {
    name: 'list_runs', access: 'read', ...READ_OPS.list_runs,
    run: ({ agent, limit = 10 }, { state }) => listRuns(state, { running: true }).filter((r) => !agent || r.agent === agent).slice(-limit).map(brief),
  },
  {
    name: 'get_run', access: 'read', ...READ_OPS.get_run,
    description: 'Full record of one run: task, answer, tools and commands used, blocked attempts, memory used and proposed. '
      + 'A run still in progress has status running.',
    run: ({ run_id }, { state }) => {
      const r = listRuns(state, { running: true }).find((x) => x.run_id === run_id);
      if (!r) throw new Error(`no run ${run_id}`);
      const { raw_events, transcript, ...rest } = r;
      return rest;
    },
  },
  {
    name: 'list_pending', access: 'read', title: 'Waiting for review',
    description: 'Proposals waiting for the user: memory notes, test cases, instruction edits (from agents or the coach).',
    input: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
    run: (_, { root }) => pending(root).map(({ id, kind, agent, why, body }) => ({ id, kind, agent, why, body })),
  },
  {
    name: 'rate_run', access: 'decide', title: 'Rate a run',
    description: "Record the USER's rating of a run or chat (good/bad + why). Only pass a rating the user gave; never rate on your own judgment.",
    input: { type: 'object', required: ['run_id', 'rating'], additionalProperties: false, properties: {
      run_id: { type: 'string', description: 'A run id, or "last"' },
      rating: { type: 'string', enum: ['good', 'bad'] },
      comment: { type: 'string', description: "The user's reason, in their words" },
    } },
    annotations: { readOnlyHint: false, idempotentHint: true },
    run: ({ run_id, rating, comment }, { state }) => `rated ${recordFeedback(run_id, rating, comment, { state }).run_id} ${rating}`,
  },
  {
    name: 'review_decide', access: 'decide', title: 'Accept or reject a proposal',
    description: 'Accept or reject one pending proposal or memory note. ONLY when the user explicitly decided this specific item; '
      + 'never on your own initiative. Accepting changes the agent and is committed to its version history.',
    input: { type: 'object', required: ['id', 'decision'], additionalProperties: false, properties: {
      id: { type: 'string' }, decision: { type: 'string', enum: ['accept', 'reject'] }, reason: { type: 'string' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: ({ id, decision, reason }, { root }) => (decision === 'accept'
      ? `accepted → ${acceptProposal(id, { root })}` : `rejected → ${rejectProposal(id, reason, { root })}`),
  },
  {
    name: 'run_eval', access: 'run', title: 'Run test cases',
    description: "Run an agent's test cases and compare the score with its previous version.",
    input: { type: 'object', required: ['agent'], additionalProperties: false, properties: { agent: { type: 'string' } } },
    annotations: { readOnlyHint: false },
    run: async ({ agent }, { root, state }) => {
      const { report, previous } = await runEvals(agent, { root, state });
      return { agent, version: report.agent_version, passed: `${report.passed}/${report.total}`, cost_usd: report.cost,
        previous: previous ? `${previous.passed}/${previous.total} (v${previous.agent_version})` : null,
        results: report.results.map((r) => ({ question: r.question, pass: r.pass, problems: r.problems, blocked: r.blocked.length })) };
    },
  },
];

function status({ root, state }) {
  const runs = listRuns(state, { running: true });
  const items = pending(root);
  const last = runs.filter((r) => r.status !== 'running').at(-1);
  return {
    agents: loadAgents(root).length, runs: runs.length, running: runs.filter((r) => r.status === 'running').length,
    pending: { memory: items.filter((p) => p.kind === 'memory').length, proposals: items.filter((p) => p.kind !== 'memory').length },
    last_run: last ? { run_id: last.run_id, agent: last.agent, status: last.status, ended: last.ended } : null,
    health: doctorHealth({ state }),
  };
}

/** Everything the dashboard shows on open. */
export function dashboardData(ctx) {
  const runs = listRuns(ctx.state, { running: true });
  const currentStatus = status(ctx);
  return {
    generated_at: new Date().toISOString(),
    capabilities: { discovery: true, status: true, context: true, run: true, mutate: true },
    status: currentStatus,
    health: currentStatus.health,
    agents: loadAgents(ctx.root).map((a) => agentSummary(a, runs)),
    runs: runs.slice(-50).map(brief),
    pending: pending(ctx.root).map(({ id, kind, agent, why, body }) => ({ id, kind, agent, why, body })),
  };
}

export const defaultContext = () => ({ root: ROOT, state: STATE, spawn: nodeSpawn });

/** Runs one operation by name. `allow` limits the access levels a surface may use. */
export async function callOp(name, args = {}, { ctx = defaultContext(), allow = ['read', 'run', 'decide'] } = {}) {
  const op = OPS.find((o) => o.name === name);
  if (!op) throw new Error(`unknown operation ${name}`);
  if (!allow.includes(op.access)) throw new Error(`${name} is not available here (${op.access})`);
  // Linked to the Hub: bring the review queue up to date (and send any receipts that were waiting) before showing it.
  if (['open_dashboard', 'get_status', 'list_pending'].includes(name) && ctx.state === STATE && linkedHub()) {
    await refreshHubCache({ state: ctx.state }); await flushOutbox({ state: ctx.state });
  }
  return op.run(args ?? {}, ctx);
}
