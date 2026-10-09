#!/usr/bin/env node
// Minimal agent launcher: plain Pi + file-based agent definitions + reviewed memory.
// Definitions (~/.agents/agents/*.md) and reviewed memory (~/.agents/memory/) live in AGENT_HOME;
// runs, sessions and raw events live in a private state directory.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.AGENT_HOME ?? path.join(os.homedir(), '.agents');
export const STATE = process.env.AGENT_WORKFLOW_STATE ?? path.join(os.homedir(), '.local/state/agent-workflow');

// ---------- files ----------

/** Parses a small YAML subset: `key: value` and `key: [a, b]` (nested keys are ignored). */
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2].trim();
    meta[kv[1]] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : raw;
  }
  return { meta, body: match[2].trim() };
}

export function formatFrontmatter(meta, body) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  return `---\n${lines.join('\n')}\n---\n${body.trim()}\n`;
}

export const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const expandHome = (p) => (p === '~' ? os.homedir() : p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const newId = (prefix) => `${prefix}-${stamp()}-${randomBytes(3).toString('hex')}`;

// ---------- agents ----------

export function loadAgents(root = ROOT) {
  const dir = path.join(root, 'agents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name ?? path.basename(file, '.md');
    return {
      name,
      file: path.join(dir, file),
      // Identifies the exact definition a run used, so improvements can be traced over time.
      version: createHash('sha256').update(text).digest('hex').slice(0, 12),
      description: meta.description ?? '',
      model: meta.model ?? null,
      thinking: meta.thinking ?? null,
      // `tools: read, grep` (the format pi extensions use) or `tools: [read, grep]`.
      tools: list(meta.tools),
      workspace: expandHome(meta.workspace ?? process.cwd()),
      // Own key so it does not clash with the `memory:` field of pi-subagents extensions.
      memory: meta.memory_scopes ? list(meta.memory_scopes) : [`agent:${name}`],
      instructions: body,
    };
  });
}

export function getAgent(name, root = ROOT) {
  const agent = loadAgents(root).find((a) => a.name === name);
  if (!agent) throw new Error(`unknown agent: ${name}`);
  return agent;
}

/** Commits AGENT_HOME when it is a git repository, so every accepted change is a version. */
export function commitHome(message, root = ROOT) {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('add', '-A');
  return git('commit', '-q', '-m', message).status === 0;
}

// ---------- memory ----------

/** Maps a scope (shared | project:<p> | agent:<a>) to its accepted-memory folder. */
export function scopeDir(scope, root = ROOT) {
  if (scope === 'shared') return path.join(root, 'memory/shared');
  const m = /^(project|agent):([a-z0-9][a-z0-9_-]*)$/.exec(scope);
  if (!m) throw new Error(`invalid memory scope: ${scope}`);
  return path.join(root, 'memory', m[1] === 'project' ? 'projects' : 'agents', m[2]);
}

function readItems(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const file = path.join(dir, f);
    return { file, ...parseFrontmatter(fs.readFileSync(file, 'utf8')) };
  });
}

/** Accepted items for the given scopes, excluding anything superseded. */
export function loadMemory(scopes, root = ROOT) {
  const items = scopes.flatMap((s) => readItems(scopeDir(s, root)));
  const superseded = new Set(items.flatMap((i) => [i.meta.supersedes].flat().filter(Boolean)));
  return items.filter((i) => i.meta.status === 'accepted' && !superseded.has(i.meta.id));
}

export const listCandidates = (root = ROOT) => readItems(path.join(root, 'memory/candidates'));

/** Extracts ```remember blocks; an optional first line `scope: x` selects the scope. */
export function extractRemember(text, agent) {
  const out = [];
  for (const m of (text ?? '').matchAll(/```remember\n([\s\S]*?)```/g)) {
    let body = m[1].trim();
    let scope = `agent:${agent.name}`;
    const s = /^scope:\s*(\S+)\s*\n/.exec(body);
    if (s) { body = body.slice(s[0].length).trim(); if (agent.memory.includes(s[1])) scope = s[1]; }
    if (body) out.push({ scope, body });
  }
  return out;
}

export function saveCandidates(proposals, { agent, runId, root = ROOT }) {
  const dir = path.join(root, 'memory/candidates');
  fs.mkdirSync(dir, { recursive: true });
  return proposals.map(({ scope, body }) => {
    const id = newId('m');
    const meta = { id, scope, status: 'candidate', proposed_by: agent.name, source_run: runId, created: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, `${id}.md`), formatFrontmatter(meta, body));
    return id;
  });
}

function findCandidate(id, root) {
  const item = listCandidates(root).find((c) => c.meta.id === id);
  if (!item) throw new Error(`no candidate ${id}`);
  return item;
}

export function acceptCandidate(id, { root = ROOT, scope, supersedes } = {}) {
  const item = findCandidate(id, root);
  const meta = { ...item.meta, scope: scope ?? item.meta.scope, status: 'accepted', accepted: new Date().toISOString(), supersedes };
  const dir = scopeDir(meta.scope, root);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${id}.md`);
  fs.writeFileSync(dest, formatFrontmatter(meta, item.body));
  fs.rmSync(item.file);
  return dest;
}

export function addMemory(scope, body, { root = ROOT } = {}) {
  const dir = scopeDir(scope, root);
  fs.mkdirSync(dir, { recursive: true });
  const id = newId('m');
  const dest = path.join(dir, `${id}.md`);
  fs.writeFileSync(dest, formatFrontmatter({ id, scope, status: 'accepted', proposed_by: 'user', accepted: new Date().toISOString() }, body));
  return dest;
}

export function rejectCandidate(id, { root = ROOT, reason } = {}) {
  const item = findCandidate(id, root);
  const dir = path.join(root, 'memory/rejected');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${id}.md`);
  fs.writeFileSync(dest, formatFrontmatter({ ...item.meta, status: 'rejected', rejected: new Date().toISOString(), reason }, item.body));
  fs.rmSync(item.file);
  return dest;
}

// ---------- runs ----------

export function buildSystemPrompt(agent, memories) {
  const parts = [`# Agent: ${agent.name}\n\n${agent.instructions}`];
  if (memories.length) {
    parts.push('## Remembered (reviewed by the user)\n\nThese notes are your long-term memory; they are already here, so answer questions about your memory from this list without searching files.\n\n' + memories
      .map((m) => `- [${m.meta.id}] (${m.meta.scope}) ${m.body.replace(/\n+/g, ' ')}`).join('\n'));
  }
  if (!memories.length) parts.push('## Remembered\n\nYou have no reviewed notes yet. Your memory lives outside the workspace; do not search for it.');
  parts.push([
    '## Proposing memory',
    'You cannot write memory yourself. If this task revealed a durable, verified fact or lesson that would help future runs,',
    'end your reply with one fenced block per item, language `remember`. Optional first line `scope: <scope>`;',
    `allowed scopes: ${agent.memory.join(', ')}. Keep each item to one or two sentences, include where it was verified,`,
    'and do not repeat items already listed under Remembered. Propose nothing when nothing durable was learned.',
  ].join('\n'));
  return parts.join('\n\n');
}

export function piArgs(agent, { task, prompt, sessionDir, resume }) {
  return [
    '-p', '--mode', 'json', '--session-dir', sessionDir,
    ...(resume ? ['-c'] : []),
    ...(agent.tools.length ? ['--tools', agent.tools.join(',')] : ['--no-tools']),
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.thinking ? ['--thinking', agent.thinking] : []),
    '--append-system-prompt', prompt,
    '--', task,
  ];
}

/** Folds Pi's JSONL events into a receipt summary. */
export function summarize(events) {
  const assistant = events.filter((e) => e.type === 'message_end' && e.message?.role === 'assistant');
  const final = assistant.at(-1)?.message;
  const usage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
  for (const { message: m } of assistant) {
    usage.input += m.usage?.input ?? 0;
    usage.output += m.usage?.output ?? 0;
    usage.totalTokens += m.usage?.totalTokens ?? 0;
    usage.cost += m.usage?.cost?.total ?? 0;
  }
  return {
    session_id: events.find((e) => e.type === 'session')?.id ?? null,
    model: final ? `${final.provider}/${final.model}` : null,
    output: final?.content?.filter((p) => p.type === 'text').map((p) => p.text).join('\n') ?? null,
    error: final?.errorMessage ?? null,
    tool_calls: events.filter((e) => e.type === 'tool_execution_start').map((e) => e.toolName),
    model_calls: assistant.length,
    usage,
  };
}

export async function runAgent(name, task, { root = ROOT, state = STATE, resume = false, useMemory = true, kind = 'task', proposeMemory = true, spawn = nodeSpawn, timeoutMs = 600_000 } = {}) {
  const agent = getAgent(name, root);
  const memories = useMemory ? loadMemory(agent.memory, root) : [];
  const runId = newId('r');
  const runsDir = path.join(state, 'runs');
  // Eval and other non-task runs keep their own sessions, so `--continue` resumes real work only.
  const sessionDir = path.join(state, 'sessions', kind === 'task' ? agent.name : `${agent.name}.${kind}`);
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const prompt = buildSystemPrompt(agent, memories);
  const started = new Date().toISOString();
  const rawFile = path.join(runsDir, `${runId}.jsonl`);

  const { events, exitCode, timedOut } = await new Promise((resolve, reject) => {
    const child = spawn('pi', piArgs(agent, { task, prompt, sessionDir, resume }), { cwd: agent.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    const raw = fs.createWriteStream(rawFile, { mode: 0o600 });
    const events = [];
    let buf = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      raw.write(chunk);
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) { try { events.push(JSON.parse(l)); } catch { /* keep raw only */ } }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); raw.end(); resolve({ events, exitCode: code, timedOut }); });
  });

  const summary = summarize(events);
  const status = timedOut ? 'unknown' : exitCode === 0 && !summary.error ? 'completed' : 'failed';
  const candidates = status === 'completed' && proposeMemory ? saveCandidates(extractRemember(summary.output, agent), { agent, runId, root }) : [];
  const receipt = {
    run_id: runId, agent: agent.name, kind, agent_version: agent.version, status, task, resumed: resume, memory_enabled: useMemory,
    workspace: agent.workspace, tools: agent.tools, started, ended: new Date().toISOString(),
    memory_supplied: memories.map((m) => m.meta.id), memory_proposed: candidates,
    exit_code: exitCode, ...summary, raw_events: rawFile,
  };
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}

/** Opens an interactive Pi session as the agent (same prompt, tools, memory and session folder). */
export function chatArgs(agent, { prompt, sessionDir, resume }) {
  return [
    '--session-dir', sessionDir,
    ...(resume ? ['-c'] : []),
    ...(agent.tools.length ? ['--tools', agent.tools.join(',')] : ['--no-tools']),
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.thinking ? ['--thinking', agent.thinking] : []),
    '--append-system-prompt', prompt,
  ];
}

export function listRuns(state = STATE) {
  const dir = path.join(state, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// ---------- CLI ----------

const USAGE = `usage:
  agent list
  agent run <agent> [--continue] [--no-memory] <task...>
  agent chat <agent> [--continue]    interactive Pi session as that agent
  agent runs [n]                      recent run receipts
  agent show <run_id>
  agent memory                        candidates waiting for review
  agent memory accept <id> [--scope s] [--supersedes id]
  agent memory reject <id> [reason...]
  agent memory add <scope> <text...>   write a note yourself (scope: shared | project:<p> | agent:<a>)

improving over time:
  agent feedback <run_id|last> good|bad [comment...]
  agent eval <agent>                  run the agent's test cases, compare with last time
  agent eval add <agent> "<question>" [--include a,b] [--exclude c] [--max-tools n]
  agent reflect <agent> [--runs n]    coach reviews recent runs + feedback, writes proposals
  agent review                        everything waiting for your decision
  agent review show <id>              one proposal (instruction edits as a diff)
  agent review accept|reject <id> [reason...]`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'list') {
    for (const a of loadAgents()) console.log(`${a.name.padEnd(14)} ${a.description}\n${''.padEnd(14)} tools=${a.tools.join(',') || 'none'} memory=${a.memory.join(',')}`);
  } else if (cmd === 'run') {
    const resume = args.includes('--continue');
    const useMemory = !args.includes('--no-memory');
    const [name, ...rest] = args.filter((a) => a !== '--continue' && a !== '--no-memory');
    if (!name || !rest.length) throw new Error(USAGE);
    const r = await runAgent(name, rest.join(' '), { resume, useMemory });
    console.log((r.output ?? r.error ?? '(no output)').replace(/```remember\n[\s\S]*?```/g, '').trim());
    console.log(`\n— ${r.status} · ${r.run_id} · ${r.model} · ${r.model_calls} model call(s) · tools: ${r.tool_calls.join(',') || 'none'} · ${r.usage.totalTokens} tok · $${r.usage.cost.toFixed(4)}`);
    console.log(`— memory supplied: ${r.memory_enabled ? r.memory_supplied.length : 'off'}${r.memory_proposed.length ? ` · proposed: ${r.memory_proposed.join(', ')} (review: agent memory)` : ''}`);
  } else if (cmd === 'chat') {
    const resume = args.includes('--continue');
    const name = args.find((a) => a !== '--continue');
    if (!name) throw new Error(USAGE);
    const agent = getAgent(name);
    const memories = loadMemory(agent.memory);
    const sessionDir = path.join(STATE, 'sessions', agent.name);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    console.log(`${agent.name}: ${memories.length} reviewed note(s) loaded; tools=${agent.tools.join(',') || 'none'}; cwd=${agent.workspace}`);
    console.log('To keep something, ask it to propose a note, then copy it into: agent memory add <scope> "<text>"\n');
    const child = nodeSpawn('pi', chatArgs(agent, { prompt: buildSystemPrompt(agent, memories), sessionDir, resume }), { cwd: agent.workspace, stdio: 'inherit' });
    await new Promise((resolve) => child.on('close', resolve));
  } else if (cmd === 'runs') {
    for (const r of listRuns().slice(-(Number(args[0]) || 10))) {
      const fb = r.feedback ? ` [${r.feedback.rating}]` : '';
      console.log(`${r.run_id}  ${r.agent.padEnd(10)} ${(r.kind ?? 'task').padEnd(6)} ${r.status.padEnd(9)} mem=${r.memory_supplied.length} +${r.memory_proposed.length}${fb}  ${r.task.slice(0, 60)}`);
    }
  } else if (cmd === 'show') {
    const r = listRuns().find((x) => x.run_id === args[0]);
    if (!r) throw new Error(`no run ${args[0]}`);
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'memory') {
    const [sub, id, ...rest] = args;
    if (!sub) {
      const c = listCandidates();
      if (!c.length) console.log('no candidates');
      for (const i of c) console.log(`${i.meta.id}  ${i.meta.scope}  (from ${i.meta.source_run})\n  ${i.body.replace(/\n+/g, ' ')}\n`);
    } else if (sub === 'accept') {
      console.log(path.relative(ROOT, acceptCandidate(id, { scope: flag(rest, '--scope'), supersedes: flag(rest, '--supersedes') })));
      commitHome(`Accept memory ${id}`);
    } else if (sub === 'add') {
      if (!id || !rest.length) throw new Error(USAGE);
      console.log(addMemory(id, rest.join(' ')));
      commitHome(`Add memory note (${id})`);
    } else if (sub === 'reject') {
      console.log(path.relative(ROOT, rejectCandidate(id, { reason: rest.join(' ') || undefined })));
      commitHome(`Reject memory ${id}`);
    } else throw new Error(USAGE);
  } else if (['feedback', 'eval', 'reflect', 'review'].includes(cmd)) {
    await (await import('./improve.mjs')).cli(cmd, args);
  } else {
    console.log(USAGE);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
