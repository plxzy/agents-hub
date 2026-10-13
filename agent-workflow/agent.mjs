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
import { modelGateway } from './model gateway.mjs';
import { captureRunContext, logObservation } from './run-context.mjs';
import { failureFromEvents } from './failure-telemetry.mjs';
import { runProgressTelemetry } from './run-progress.mjs';
import { linuxPolicy } from './linux-sandbox.mjs';
import { linkedHub, sendReceipt, flushOutbox, hubMemory, trackHubRun, DECIDE_IN_HUB } from './hub.mjs';

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
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try { meta[kv[1]] = JSON.parse(raw); }
      catch { meta[kv[1]] = raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean); }
    } else meta[kv[1]] = raw;
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

function hereWritePaths(value) {
  return list(value).map((p) => {
    const normalized = path.normalize(p);
    if (path.isAbsolute(p) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`here_write paths must be relative and stay inside the start folder: ${p}`);
    }
    return p;
  });
}

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
      hereWrite: meta.here_write === undefined ? null : hereWritePaths(meta.here_write),
      // Own key so it does not clash with the `memory:` field of pi-subagents extensions.
      memory: meta.memory_scopes ? list(meta.memory_scopes) : [`agent:${name}`],
      // By name: AGENT_HOME/agent-skills/<name>/ (only agents that list it) or AGENT_HOME/skills/<name>/ (shared;
      // Pi also loads those for every agent on its own).
      skills: meta.skills === 'none' ? 'none' : list(meta.skills).map((n) =>
        [path.join(root, 'agent-skills', n), path.join(root, 'skills', n)].find((d) => fs.existsSync(d)) ?? path.join(root, 'agent-skills', n)),
      // Enforced (not just instructed) bash policy: `guard: readonly` loads guards/readonly-bash.ts.
      guard: meta.guard ?? null,
      // Where runs happen: `local` (Pi on this Mac). Other runners (cloud) plug in through ops.mjs later.
      runner: meta.runner ?? 'local',
      sudoAllow: list(meta.sudo_allow),
      // Folders the agent may write to. When set, Pi runs inside a macOS sandbox that denies every other write
      // in the home folder (see sandboxProfile); `protect_paths` are kept read-only even inside them.
      writePaths: meta.write_paths ? list(meta.write_paths).map(expandHome) : null,
      protectPaths: list(meta.protect_paths).map(expandHome),
      instructions: body,
      context: process.env.AGENT_CONTEXT_ROOT || null,
    };
  });
}

export function formatAgentListEntry(a) {
  const details = [`tools=${a.tools.join(',') || 'none'}`, `memory=${a.memory.join(',')}`];
  if (a.guard) details.push(`guard=${a.guard}`);
  if (a.skills !== 'none' && a.skills.length) details.push(`skills=${a.skills.map((s) => path.basename(s)).join(',')}`);
  if (a.writePaths?.length) details.push(`writes=${a.writePaths.join(',')}`);
  if (a.hereWrite != null) details.push(`here_write=${a.hereWrite.join(',') || 'none'}`);
  return `${a.name.padEnd(14)} ${a.description}\n${''.padEnd(14)} ${details.join(' ')}`;
}

export function getAgent(name, root = ROOT) {
  const agent = loadAgents(root).find((a) => a.name === name);
  if (!agent) throw new Error(`unknown agent: ${name}`);
  return agent;
}

/** Resolve `here` per invocation, without changing the loaded definition or its permissions. */
export function resolveWorkspace(agent, cwd = process.cwd()) {
  if (agent.workspace !== 'here') return agent;
  const workspace = fs.realpathSync(cwd);
  const home = fs.realpathSync(os.homedir());
  const relative = path.relative(home, workspace);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('workspace: here requires a folder strictly inside the home folder');
  }
  if (!fs.statSync(workspace).isDirectory()) throw new Error('workspace: here requires a directory');
  return { ...agent, workspace, workspaceId: createHash('sha256').update(workspace).digest('hex').slice(0, 12),
    writePaths: [...(agent.writePaths ?? []), ...(agent.hereWrite == null ? [workspace]
      : hereWritePaths(agent.hereWrite).map((p) => path.resolve(workspace, p)))] };
}

/** Task and chat share history; other run kinds stay separate, as do folders for `here` agents. */
export function sessionDirectory(agent, state = STATE, kind = 'task') {
  const name = kind === 'task' ? agent.name : `${agent.name}.${kind}`;
  return path.join(state, 'sessions', agent.workspaceId ? `${name}.${agent.workspaceId}` : name);
}

/** Commits AGENT_HOME when it is a git repository, so every accepted change is a version. */
export function commitHome(message, root = ROOT) {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('add', '-A', '--', '.', ':(exclude)memory/candidates/');
  // Pending notes are user-owned, even if a caller already staged them.
  git('reset', '-q', 'HEAD', '--', 'memory/candidates/');
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

function candidateAge(created, now) {
  const elapsed = now - Date.parse(created);
  if (!Number.isFinite(elapsed)) return 'age unknown';
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (seconds >= size || size === 1) return `${Math.floor(seconds / size)}${unit} ago`;
  }
}

export function formatCandidateList(candidates, now = Date.now()) {
  const items = candidates.map(({ meta, body }, index) => {
    const lines = [];
    let line = '    ';
    for (const word of body.trim().split(/\s+/)) {
      if (line.length > 4 && line.length + word.length + 1 > 90) {
        lines.push(line);
        line = '    ';
      }
      line += `${line.length > 4 ? ' ' : ''}${word}`;
    }
    lines.push(line);
    return `${index + 1}. ${meta.id.slice(-6)} · ${meta.scope} · proposed by ${meta.proposed_by ?? 'unknown'} · ${candidateAge(meta.created, now)}\n`
      + `   source run: ${meta.source_run ?? 'unknown'}\n${lines.join('\n')}`;
  });
  return [`${candidates.length} candidate${candidates.length === 1 ? '' : 's'} waiting for review`, ...items,
    'agent memory accept <n|id> · agent memory reject <n|id> [reason]'].join('\n\n');
}

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

function findCandidate(selector, root) {
  const candidates = listCandidates(root);
  const value = String(selector ?? '');
  // Consider every interpretation, including all-digit hex suffixes that are also list numbers.
  const matches = candidates.filter((c, index) => c.meta.id === value
    || (/^[a-f0-9]{6}$/i.test(value) && c.meta.id.slice(-6).toLowerCase() === value.toLowerCase())
    || (/^[1-9]\d*$/.test(value) && index + 1 === Number(value)));
  if (!matches.length) throw new Error(`no candidate ${value}`);
  if (matches.length > 1) throw new Error(`ambiguous candidate ${value}; use a full id`);
  return matches[0];
}

export function acceptCandidate(id, { root = ROOT, scope, supersedes } = {}) {
  const item = findCandidate(id, root);
  const meta = { ...item.meta, scope: scope ?? item.meta.scope, status: 'accepted', accepted: new Date().toISOString(), supersedes };
  const dir = scopeDir(meta.scope, root);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${item.meta.id}.md`);
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
  const dest = path.join(dir, `${item.meta.id}.md`);
  fs.writeFileSync(dest, formatFrontmatter({ ...item.meta, status: 'rejected', rejected: new Date().toISOString(), reason }, item.body));
  fs.rmSync(item.file);
  return dest;
}

// ---------- runs ----------

export function buildSystemPrompt(agent, memories) {
  const parts = [`# Agent: ${agent.name}\n\n${agent.instructions}`];
  if (agent.context) parts.push(`Dated read-only Space reference: ${agent.context}. The live Space remains the editable source; this reference is not current runtime health evidence.`);
  if (agent.linuxPolicy) parts.push(`## Current host boundary (dok-dev)\nThis is the Linux development executor. The only writable project is ${agent.workspace}. Reviewed knowledge and skills are versioned read-only snapshots. Mac paths and activity in historical notes describe the Mac, not this host. Do not infer Mac activity or live Space state. Use the explicit skill paths supplied here. Changes to agent definitions must be proposed in the project for operator review; the active knowledge snapshot cannot be changed. Shell networking is isolated except sandbox-local loopback. Model inference uses the selected provider. Installing or activating supervisor changes is an operator action.`);
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

const GUARDS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guards');
const guardArgs = (agent) => agent.linuxPolicy ? ['-e', path.join(agent.linuxPolicy.release, 'linux-tools.ts')] : [...(agent.guard ? ['-e', path.join(GUARDS, `${agent.guard}-bash.ts`)] : []),
  ...(agent.remote ? ['-e', path.join(GUARDS, 'remote.ts')] : [])];
/** Environment for the Pi process: guards read the allowed sudo prefixes and protected paths from it. */
export const agentEnv = (agent, root = ROOT) => ({
  ...process.env,
  ...(agent.writePaths ? { AGENT_SANDBOXED: '1' } : {}),
  // Marks Pi processes started for an agent, so add-ons meant for the user's own sessions (the agents Pi package) stay out.
  AGENT_RUN: '1',
  ...(agent.linuxPolicy ? { AGENT_LINUX_POLICY: JSON.stringify(agent.linuxPolicy) } : {}),
  AGENT_SUDO_ALLOW: JSON.stringify(agent.sudoAllow.map((p) => `sudo -n ${p}`)),
  // Never editable by an agent: its own definition, the user's accepted memory and past decisions.
  AGENT_PROTECTED: JSON.stringify([agent.file, ...['shared', 'projects', 'agents', 'rejected'].map((d) => path.join(root, 'memory', d)),
    path.join(root, 'proposals/rejected'), ...agent.protectPaths]),
});

// Credential stores no sandboxed agent may read or write (Pi's own login under ~/.pi stays readable for Pi itself).
const SECRET_PATHS = ['.ssh', '.aws', '.docker/config.json', '.netrc', '.config/gh', '.config/gcloud', '.codex/auth.json',
  '.codex/multi-auth', '.claude/.credentials.json', '.config/agent-readonly', 'Library/Keychains', 'Library/Cookies', 'Library/Application Support/Google/Chrome'];

/** macOS sandbox profile: writes in the home folder only to write_paths and Pi's own folders; no credential stores. */
export function sandboxProfile(agent, { home = os.homedir(), state = STATE } = {}) {
  const q = (p) => JSON.stringify(p);
  const writable = [...agent.writePaths, path.join(home, '.pi'), state, path.join(home, '.cache'), path.join(home, 'Library/Caches'), path.join(home, '.npm')];
  return ['(version 1)', '(allow default)',
    `(deny file-write* (subpath ${q(home)}))`,
    `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    `(deny file-read* file-write* ${SECRET_PATHS.map((p) => `(subpath ${q(path.join(home, p))})`).join(' ')})`].join('\n');
}

/** [command, args] that starts Pi for this agent, inside the sandbox when the agent has write_paths. */
export function assertSandboxAllowed(agent, command = `agent run ${agent.name} "<task>"`, env = process.env) {
  if (agent.writePaths && env.AGENT_SANDBOXED === '1') {
    throw new Error(`cannot start a sandboxed agent from inside a sandbox; ask the user to run: ${command}`);
  }
}

export const piCommand = (agent, args) => {
  assertSandboxAllowed(agent);
  if (agent.linuxPolicy) return ['pi', ['--no-builtin-tools', '--no-extensions', '--no-mcp', '--no-skills',
    '--no-context-files', '--no-prompt-templates', '--no-themes', ...args]];
  return agent.writePaths ? ['sandbox-exec', ['-p', sandboxProfile(agent), 'pi', ...args]] : ['pi', args];
};

export function remoteSandbox(agent, env = process.env) {
  if (env.AGENT_REMOTE_RUN !== '1') return agent;
  // Even normally unsandboxed read-only helpers cannot inspect the relay/publisher credentials.
  return { ...agent, writePaths: agent.writePaths ?? [], guard: agent.guard ?? 'readonly', remote: true };
}

export function piArgs(agent, { task, prompt, sessionDir, resume }) {
  return [
    ...guardArgs(agent),
    '-p', '--mode', 'json', '--session-dir', sessionDir,
    ...(resume ? ['-c'] : []),
    ...(agent.tools.length ? ['--tools', agent.tools.join(',')] : ['--no-tools']),
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.thinking ? ['--thinking', agent.thinking] : []),
    ...(agent.skills === 'none' ? ['--no-skills'] : (agent.skills ?? []).flatMap((d) => ['--skill', d])),
    '--append-system-prompt', prompt,
    '--', task,
  ];
}

const isBlocked = (text) => /^Blocked by /.test(text ?? '');
function bashCalls(events) {
  const ended = new Map(events.filter((e) => e.type === 'tool_execution_end').map((e) => [e.toolCallId, e.result?.content?.[0]?.text]));
  return events.filter((e) => e.type === 'tool_execution_start' && e.toolName === 'bash')
    .map((e) => ({ command: e.args?.command ?? '', blocked: isBlocked(ended.get(e.toolCallId)) }));
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
    error: final?.errorMessage || (['error', 'aborted'].includes(final?.stopReason) ? final.stopReason : null),
    tool_calls: events.filter((e) => e.type === 'tool_execution_start').map((e) => e.toolName),
    // Commands that actually ran; attempts a guard stopped are kept separately as `blocked`.
    commands: bashCalls(events).filter((c) => !c.blocked).map((c) => c.command),
    blocked: bashCalls(events).filter((c) => c.blocked).map((c) => c.command),
    model_calls: assistant.length,
    usage,
  };
}

/** Marker for a run in progress (`<id>.running`); the receipt replaces it when the run ends. */
export function writeRunningMarker(state, { run_id, agent, kind = 'task', task, workspace, pid }) {
  const runsDir = path.join(state, 'runs');
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const marker = { run_id, agent, kind, status: 'running', task, workspace, started: new Date().toISOString(), pid };
  fs.writeFileSync(path.join(runsDir, `${run_id}.running`), JSON.stringify(marker) + '\n', { mode: 0o600 });
  return marker;
}

export async function runAgent(name, task, { root = ROOT, state = STATE, resume = false, useMemory = true, kind = 'task', proposeMemory = true, spawn = nodeSpawn, timeoutMs = 600_000, cwd = process.cwd(), runId = newId('r'), hubConfig, fetchImpl = fetch } = {}) {
  if (fs.existsSync(path.join(root, 'RELEASE.json'))) proposeMemory = false;
  const agent = remoteSandbox(resolveWorkspace(getAgent(name, root), cwd));
  assertSandboxAllowed(agent, `agent run ${name} ${JSON.stringify(task)}`);
  if (process.platform === 'linux' && agent.writePaths && spawn === nodeSpawn) agent.linuxPolicy = linuxPolicy(agent, state);
  // Linked to the Hub (default home and state only): accepted notes come from there, local files are the offline fallback.
  const hub = hubConfig === undefined ? (state === STATE && root === ROOT && linkedHub()) : hubConfig;
  const hubOptions = { config: hub, fetchImpl, state };
  const fetched = useMemory && hub ? await hubMemory(agent.memory, hubOptions) : null;
  const memories = fetched ? fetched.items : useMemory ? loadMemory(agent.memory, root) : [];
  const trace = captureRunContext(agent.workspace);
  const runsDir = path.join(state, 'runs');
  // Eval and other non-task runs keep their own sessions, so `--continue` resumes real work only.
  const sessionDir = sessionDirectory(agent, state, kind);
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const prompt = buildSystemPrompt(agent, memories);
  const runningMarker = writeRunningMarker(state, { run_id: runId, agent: agent.name, kind, task, workspace: agent.workspace, pid: process.pid });
  Object.assign(runningMarker, trace);
  const { started } = runningMarker, progress = runProgressTelemetry();
  const marker = path.join(runsDir, `${runId}.running`);
  const rawFile = path.join(runsDir, `${runId}.jsonl`);
  fs.writeFileSync(marker, JSON.stringify({ ...runningMarker, progress: progress.snapshot() }) + '\n', { mode: 0o600 });

  const stopHeartbeat = await trackHubRun({ run_id: runId, agent: agent.name, kind, task, started, model: agent.model,
    agent_version: agent.version, ...trace, progress: progress.snapshot() }, hubOptions);
  let progressSavedAt = 0;
  const observe = event => {
    if (!progress.observe(event)) return;
    const update = progress.snapshot();
    stopHeartbeat.update(update);
    if (Date.now() - progressSavedAt < 1000 && !['tool_execution_start', 'tool_execution_end', 'message_end'].includes(event.type)) return;
    progressSavedAt = Date.now();
    const tmp = marker + '.next';
    fs.writeFileSync(tmp, JSON.stringify({ ...runningMarker, progress: update }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, marker);
  };
  let result, gateway, launchError;
  try {
    gateway = await modelGateway(agent);
    result = await new Promise((resolve, reject) => {
      const child = spawn(...piCommand(agent, piArgs(agent, { task, prompt, sessionDir, resume })), { cwd: agent.workspace, env: { ...agentEnv(agent, root), ...gateway.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const raw = fs.createWriteStream(rawFile, { mode: 0o600 });
      raw.on('error', reject);
      const events = [];
      let buf = '';
      let timedOut = false;
      child.stdout.on('data', (chunk) => {
        raw.write(chunk);
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) if (l.trim()) { try { const event = JSON.parse(l); events.push(event); observe(event); } catch { /* keep raw only */ } }
      });
      child.stderr.on('data', () => {});
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); raw.end(); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buf.trim()) { try { const event = JSON.parse(buf); events.push(event); observe(event); } catch { /* incomplete event stays in raw log */ } }
        raw.end(() => resolve({ events, exitCode: code, timedOut }));
      });
    });
  } catch (e) { launchError = e; result = { events: [], exitCode: null, timedOut: false }; }
  finally {
    try { await gateway?.close(); } catch (e) { launchError ??= e; }
    await stopHeartbeat();
  }
  const { events, exitCode, timedOut } = result;

  const summary = summarize(events);
  if (launchError) summary.error = launchError.message;
  const status = timedOut ? 'unknown' : exitCode === 0 && !summary.error ? 'completed' : 'failed';
  if (status !== 'completed') {
    summary.error ||= timedOut ? 'Run time limit exceeded' : `Pi process exited (${exitCode ?? 'no exit code'})`;
    Object.assign(summary, failureFromEvents(events, summary.error));
  }
  const proposals = status === 'completed' && proposeMemory ? extractRemember(summary.output, agent) : [];
  // Linked: proposals travel with the receipt and wait in the Hub panel; no local candidate file (that would fork the queue).
  const candidates = hub ? proposals.map(() => 'hub') : proposals.length ? saveCandidates(proposals, { agent, runId, root }) : [];
  const receipt = {
    run_id: runId, agent: agent.name, kind, agent_version: agent.version, status, task, resumed: resume, memory_enabled: useMemory,
    workspace: agent.workspace, ...trace, tools: agent.tools, started, ended: new Date().toISOString(),
    memory_supplied: memories.map((m) => m.meta.id), memory_proposed: candidates,
    ...(hub && useMemory ? { memory_source: fetched ? 'hub' : 'local-fallback', ...(fetched ? { memory_hash: fetched.hash } : {}) } : {}),
    exit_code: exitCode, ...summary, commit: captureRunContext(agent.workspace).base_commit,
    progress: progress.snapshot(), raw_events: rawFile, logs: logObservation(rawFile, 'events'),
  };
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(marker, { force: true });
  if (hub) { await flushOutbox(hubOptions); await sendReceipt(receipt, { ...hubOptions, proposals }); }
  if (launchError) throw launchError;
  return receipt;
}

/** Opens an interactive Pi session as the agent (same prompt, tools, memory and session folder). */
export function chatArgs(agent, { prompt, sessionDir, resume }) {
  return [
    ...guardArgs(agent),
    '--session-dir', sessionDir,
    ...(resume ? ['-c'] : []),
    ...(agent.tools.length ? ['--tools', agent.tools.join(',')] : ['--no-tools']),
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.thinking ? ['--thinking', agent.thinking] : []),
    ...(agent.skills === 'none' ? ['--no-skills'] : (agent.skills ?? []).flatMap((d) => ['--skill', d])),
    '--append-system-prompt', prompt,
  ];
}

/** One interactive invocation has a stable running id, even before Pi has written a conversation file. */
export async function runChat(name, { root = ROOT, state = STATE, resume = false, cwd = process.cwd(), spawn = nodeSpawn,
  hubConfig, fetchImpl = fetch, log = console.log } = {}) {
  const agent = resolveWorkspace(getAgent(name, root), cwd);
  assertSandboxAllowed(agent, `agent chat ${name}${resume ? ' --continue' : ''}`);
  if (process.platform === 'linux' && agent.writePaths && spawn === nodeSpawn) agent.linuxPolicy = linuxPolicy(agent, state);
  const hub = hubConfig === undefined ? (state === STATE && root === ROOT && linkedHub()) : hubConfig;
  const hubOptions = { config: hub, fetchImpl, state };
  const fetched = hub ? await hubMemory(agent.memory, hubOptions) : null;
  const memories = fetched ? fetched.items : loadMemory(agent.memory, root);
  const trace = captureRunContext(agent.workspace);
  const sessionDir = sessionDirectory(agent, state), runsDir = path.join(state, 'runs');
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessions = () => fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  const before = new Map(sessions().map(f => [f, fs.statSync(path.join(sessionDir, f)).mtimeMs]));
  log(`${agent.name}: ${memories.length} reviewed note(s) loaded; tools=${agent.tools.join(',') || 'none'}; cwd=${agent.workspace}`);
  log('When you exit, this chat is saved as a run you can rate and the coach can learn from.\n');
  const marker = writeRunningMarker(state, { run_id: newId('c'), agent: agent.name, kind: 'chat',
    task: `Interactive chat with ${agent.name}`, workspace: agent.workspace, pid: process.pid });
  Object.assign(marker, trace);
  fs.writeFileSync(path.join(runsDir, `${marker.run_id}.running`), JSON.stringify(marker) + '\n', { mode: 0o600 });
  const stopHeartbeat = await trackHubRun({ ...marker, model: agent.model, agent_version: agent.version }, hubOptions);
  let gateway, launchError, exitCode;
  try {
    gateway = await modelGateway(agent);
    const child = spawn(...piCommand(agent, chatArgs(agent, { prompt: buildSystemPrompt(agent, memories), sessionDir, resume })),
      { cwd: agent.workspace, env: { ...agentEnv(agent, root), ...gateway.env }, stdio: 'inherit' });
    exitCode = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  } catch (e) { launchError = e; }
  finally {
    try { await gateway?.close(); } catch (e) { launchError ??= e; }
    await stopHeartbeat();
  }
  const receipts = sessions().flatMap(f => {
    const file = path.join(sessionDir, f);
    if (before.get(f) === fs.statSync(file).mtimeMs) return [];
    const r = receiptFromSession(fs.readFileSync(file, 'utf8'), { agent, memories, file });
    return r ? [r] : [];
  });
  if (!receipts.length) receipts.push({ ...marker, ...summarize([]), memory_supplied: memories.map(m => m.meta.id),
    memory_proposed: [], turns: 0, status: 'interrupted', error: 'Chat closed without a saved conversation.' });
  // Replace the live row, including when an empty chat closes. Additional Pi sessions keep distinct receipts.
  receipts[0].run_id = marker.run_id;
  receipts[0].started = marker.started;
  for (const receipt of receipts) {
    Object.assign(receipt, trace, { commit: captureRunContext(agent.workspace).base_commit, logs: logObservation(receipt.session_file, 'session') });
    receipt.ended ??= new Date().toISOString();
    if (launchError || exitCode !== 0) {
      receipt.status = 'failed'; receipt.error = launchError?.message ?? `Chat process exited with code ${exitCode}`;
    }
    const proposals = receipt.status === 'completed' && !fs.existsSync(path.join(root, 'RELEASE.json'))
      ? extractRemember(receipt.all_text, agent) : [];
    receipt.memory_proposed = hub ? proposals.map(() => 'hub')
      : proposals.length ? saveCandidates(proposals, { agent, runId: receipt.run_id, root }) : [];
    if (hub) { receipt.memory_source = fetched ? 'hub' : 'local-fallback'; if (fetched) receipt.memory_hash = fetched.hash; }
    delete receipt.all_text;
    fs.writeFileSync(path.join(runsDir, `${receipt.run_id}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    if (hub) await sendReceipt(receipt, { ...hubOptions, proposals });
    log(`\nsaved chat as ${receipt.run_id} (${receipt.turns} message(s), $${receipt.usage.cost.toFixed(4)}). ${hub ? 'Rate it in the Agents Hub panel.' : 'Rate it: agent feedback last good|bad "why"'}`);
  }
  fs.rmSync(path.join(runsDir, `${marker.run_id}.running`), { force: true });
  if (hub) await flushOutbox(hubOptions);
  if (launchError) throw launchError;
  return receipts;
}

/** Builds a run receipt from a Pi session file written by `agent chat`, so chats can be rated and reflected on. */
export function receiptFromSession(text, { agent, memories = [], file } = {}) {
  const msgs = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'message').map((e) => e.message);
  const textOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(m.content ?? ''));
  const users = msgs.filter((m) => m.role === 'user');
  const assistants = msgs.filter((m) => m.role === 'assistant');
  if (!users.length) return null;
  const calls = assistants.flatMap((m) => (m.content ?? []).filter((p) => p.type === 'toolCall'));
  const blockedIds = new Set(msgs.filter((m) => m.role === 'toolResult' && isBlocked(textOf(m))).map((m) => m.toolCallId));
  const usage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
  for (const m of assistants) {
    usage.input += m.usage?.input ?? 0; usage.output += m.usage?.output ?? 0;
    usage.totalTokens += m.usage?.totalTokens ?? 0; usage.cost += m.usage?.cost?.total ?? 0;
  }
  const last = assistants.filter((m) => textOf(m).trim()).at(-1);
  const transcript = msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && textOf(m).trim())
    .map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${textOf(m).slice(0, 800)}`).join('\n\n');
  return {
    run_id: newId('c'), agent: agent.name, kind: 'chat', agent_version: agent.version, status: 'completed',
    task: textOf(users[0]).slice(0, 500), turns: users.length, workspace: agent.workspace, tools: agent.tools,
    started: users[0].timestamp ? new Date(users[0].timestamp).toISOString() : null,
    ended: last?.timestamp ? new Date(last.timestamp).toISOString() : null,
    memory_supplied: memories.map((m) => m.meta.id), memory_proposed: [],
    model: last ? `${last.provider}/${last.model}` : null, output: last ? textOf(last) : null,
    transcript: transcript.length > 8000 ? `...${transcript.slice(-8000)}` : transcript,
    all_text: assistants.map(textOf).join('\n'),
    tool_calls: calls.map((c) => c.name),
    commands: calls.filter((c) => c.name === 'bash' && !blockedIds.has(c.id)).map((c) => c.arguments?.command ?? ''),
    blocked: calls.filter((c) => c.name === 'bash' && blockedIds.has(c.id)).map((c) => c.arguments?.command ?? ''),
    model_calls: assistants.length, usage, session_file: file,
  };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Finished runs (receipts), oldest first. `running: true` adds runs still in progress, and ones whose process
 *  died without a receipt as `interrupted`. */
export function listRuns(state = STATE, { running = false } = {}) {
  const dir = path.join(state, 'runs');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const runs = files.filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  if (!running) return runs;
  const done = new Set(runs.map((r) => r.run_id));
  const open = files.filter((f) => f.endsWith('.running')).sort().flatMap((f) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]; } catch { return []; }
  }).filter((m) => !done.has(m.run_id)).map((m) => (alive(m.pid) ? m : { ...m, status: 'interrupted' }));
  return [...runs, ...open].sort((a, b) => String(a.started ?? '').localeCompare(String(b.started ?? '')));
}

// ---------- CLI ----------

const USAGE = `usage:
  agent list
  agent sync pull                    mirror the Agents Hub's decisions (memory notes, ratings) into ~/.agents
  agent sync push                    publish committed agents, skills and evals from ~/.agents to the Hub
  agent run <agent> [--continue] [--no-memory] <task...>
  agent chat <agent> [--continue]    interactive Pi session as that agent
  agent runs [n]                      recent run receipts
  agent show <run_id>
  agent memory                        candidates waiting for review
  agent memory accept <n|id> [--scope s] [--supersedes id]
  agent memory reject <n|id> [reason...]
    n: current list number; id: full id or unique 6-hex suffix (ambiguous matches refused).
  agent memory add <scope> <text...>   write a note yourself (scope: shared | project:<p> | agent:<a>)

improving over time:
  agent feedback <run_id|last> good|bad [comment...]
  agent eval <agent>                  run the agent's test cases, compare with last time
  agent eval add <agent> [--include regex] [--exclude regex] [--run regex] [--not-run regex] [--max-tools n] [--cwd /dir] "<question>"
    Regex flags are repeatable (one per regex). Legacy comma lists: only a single flag value without '{'.
  agent reflect <agent> [--runs n]    coach reviews recent runs + feedback, writes proposals
  agent review                        everything waiting for your decision
  agent review show <id>              one proposal (instruction edits as a diff)
  agent review accept|reject <id> [reason...]

other apps:
  agent ui [--port n] [--no-open]     dashboard in your browser (127.0.0.1, while this runs)
  agent mcp                           MCP server on stdio (Claude, Codex, Pi)
  agent call <operation> ['{json}']   run one operation from ops.mjs and print the result as JSON`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'list') {
    for (const a of loadAgents()) console.log(formatAgentListEntry(a));
  } else if (cmd === 'run') {
    const runId = flag(args, '--run-id'); // set by start_run (ops.mjs), which already told the caller this id
    const resume = args.includes('--continue');
    const useMemory = !args.includes('--no-memory');
    const [name, ...rest] = args.filter((a) => a !== '--continue' && a !== '--no-memory');
    if (!name || !rest.length) throw new Error(USAGE);
    const r = await runAgent(name, rest.join(' '), { resume, useMemory, ...(runId ? { runId } : {}) });
    console.log((r.output ?? r.error ?? '(no output)').replace(/```remember\n[\s\S]*?```/g, '').trim());
    console.log(`\n— ${r.status} · ${r.run_id} · ${r.model} · ${r.model_calls} model call(s) · tools: ${r.tool_calls.join(',') || 'none'} · ${r.usage.totalTokens} tok · $${r.usage.cost.toFixed(4)}`);
    console.log(`— memory supplied: ${r.memory_enabled ? r.memory_supplied.length : 'off'}${r.memory_proposed.length ? ` · proposed: ${r.memory_proposed.join(', ')} (review: agent memory)` : ''}`);
  } else if (cmd === 'chat') {
    const resume = args.includes('--continue');
    const name = args.find((a) => a !== '--continue');
    if (!name) throw new Error(USAGE);
    await runChat(name, { resume });
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
    if (sub && fs.existsSync(path.join(ROOT, 'RELEASE.json'))) throw new Error('Reviewed release is read-only; review memory in its owning repository and install a new knowledge release');
    if (['accept', 'reject', 'add'].includes(sub) && linkedHub()) throw new Error(DECIDE_IN_HUB);
    if (!sub) {
      console.log(formatCandidateList(listCandidates()));
    } else if (sub === 'accept') {
      const dest = acceptCandidate(id, { scope: flag(rest, '--scope'), supersedes: flag(rest, '--supersedes') });
      console.log(path.relative(ROOT, dest));
      commitHome(`Accept memory ${path.basename(dest, '.md')}`);
    } else if (sub === 'add') {
      if (!id || !rest.length) throw new Error(USAGE);
      console.log(addMemory(id, rest.join(' ')));
      commitHome(`Add memory note (${id})`);
    } else if (sub === 'reject') {
      const dest = rejectCandidate(id, { reason: rest.join(' ') || undefined });
      console.log(path.relative(ROOT, dest));
      commitHome(`Reject memory ${path.basename(dest, '.md')}`);
    } else throw new Error(USAGE);
  } else if (cmd === 'sync') {
    await (await import('./sync.mjs')).cli(args);
  } else if (cmd === 'mcp') {
    (await import('./mcp.mjs')).serveStdio();
  } else if (cmd === 'call') {
    const [op, json] = args;
    if (!op) throw new Error(USAGE);
    const value = await (await import('./ops.mjs')).callOp(op, json ? JSON.parse(json) : {});
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } else if (cmd === 'ui') {
    const port = Number(flag(args, '--port') ?? 0);
    const { startUi } = await import('./ui/server.mjs');
    const { url } = await startUi({ port, open: !args.includes('--no-open'), spawn: nodeSpawn });
    console.log(`Agents dashboard: ${url}\n(only on this Mac; stops when you press Ctrl-C)`);
  } else if (['feedback', 'eval', 'reflect', 'review'].includes(cmd)) {
    await (await import('./improve.mjs')).cli(cmd, args);
  } else {
    console.log(USAGE);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
