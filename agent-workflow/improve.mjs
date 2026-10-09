// The improvement loop: feedback on runs, test cases (evals) that measure an agent, a coach that
// turns evidence into proposals, and one review queue. Nothing changes an agent until you accept it,
// and every accepted change is committed in AGENT_HOME, so each agent version can be diffed and reverted.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, STATE, acceptCandidate, commitHome, extractRemember, formatFrontmatter, getAgent, list,
  listCandidates, listRuns, loadMemory, newId, parseFrontmatter, rejectCandidate, runAgent, saveCandidates, summarize,
} from './agent.mjs';

// ---------- feedback ----------

export function recordFeedback(ref, rating, comment, { state = STATE } = {}) {
  if (!['good', 'bad'].includes(rating)) throw new Error('rating must be good or bad');
  const runs = listRuns(state).filter((r) => ['task', 'chat'].includes(r.kind ?? 'task'));
  const run = ref === 'last' ? runs.at(-1) : runs.find((r) => r.run_id === ref);
  if (!run) throw new Error(`no run ${ref}`);
  run.feedback = { rating, comment: comment || undefined, at: new Date().toISOString() };
  fs.writeFileSync(path.join(state, 'runs', `${run.run_id}.json`), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
  return run;
}

// ---------- evals ----------

const evalDir = (agent, root) => path.join(root, 'evals', agent);

export function loadEvals(agent, root = ROOT) {
  const dir = evalDir(agent, root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: meta.id ?? path.basename(f, '.md'), question: body, include: list(meta.must_include),
      exclude: list(meta.must_not_include), run: list(meta.must_run), notRun: list(meta.must_not_run), maxTools: meta.max_tools === undefined ? null : Number(meta.max_tools), why: meta.why };
  });
}

export function addEval(agent, question, { include = [], exclude = [], run = [], notRun = [], maxTools = null, why, root = ROOT } = {}) {
  const id = newId('e');
  const dir = evalDir(agent, root);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id, agent, must_include: include.length ? include.join(', ') : undefined,
    must_not_include: exclude.length ? exclude.join(', ') : undefined, must_run: run.length ? run.join(', ') : undefined,
    must_not_run: notRun.length ? notRun.join(', ') : undefined, max_tools: maxTools ?? undefined, why };
  fs.writeFileSync(path.join(dir, `${id}.md`), formatFrontmatter(meta, question));
  return id;
}

/** Pure check of one answer against a case: patterns are case-insensitive regular expressions.
 *  `run`/`notRun` match the bash commands the agent executed (behaviour, not wording). */
export function checkCase(c, { output, toolCalls, commands = [] }) {
  const text = output ?? '';
  const ran = (p) => commands.some((cmd) => new RegExp(p, 'i').test(cmd));
  const problems = [
    ...(c.run ?? []).filter((p) => !ran(p)).map((p) => `did not run /${p}/`),
    ...(c.notRun ?? []).filter((p) => ran(p)).map((p) => `ran /${p}/`),
    ...c.include.filter((p) => !new RegExp(p, 'i').test(text)).map((p) => `missing /${p}/`),
    ...c.exclude.filter((p) => new RegExp(p, 'i').test(text)).map((p) => `contains /${p}/`),
    ...(c.maxTools !== null && toolCalls > c.maxTools ? [`${toolCalls} tool calls > ${c.maxTools}`] : []),
  ];
  return { pass: problems.length === 0, problems };
}

export async function runEvals(name, { root = ROOT, state = STATE, run = runAgent } = {}) {
  const agent = getAgent(name, root);
  const cases = loadEvals(name, root);
  if (!cases.length) throw new Error(`no eval cases for ${name}; add one with: agent eval add ${name} "<question>" --include ...`);
  const results = [];
  for (const c of cases) {
    const r = await run(name, c.question, { root, state, kind: 'eval', proposeMemory: false });
    results.push({ id: c.id, question: c.question, run_id: r.run_id, status: r.status,
      ...checkCase(c, { output: r.output, toolCalls: r.tool_calls.length, commands: r.commands ?? [] }),
      blocked: r.blocked ?? [], tool_calls: r.tool_calls.length, tokens: r.usage.totalTokens, cost: r.usage.cost });
  }
  const report = {
    agent: name, agent_version: agent.version, at: new Date().toISOString(),
    memory: loadMemory(agent.memory, root).map((m) => m.meta.id),
    passed: results.filter((x) => x.pass).length, total: results.length,
    tokens: results.reduce((a, x) => a + x.tokens, 0), cost: results.reduce((a, x) => a + x.cost, 0), results,
  };
  const dir = path.join(state, 'evals', name);
  const previous = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1) : undefined;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${report.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { report, previous: previous ? JSON.parse(fs.readFileSync(path.join(dir, previous), 'utf8')) : null };
}

// ---------- reflect (the coach) ----------

const COACH = `You coach an AI agent so it gets better over time. You receive its current definition, its
reviewed memory, its recent runs (task, answer, tools used, cost, the user's rating) and its test cases with
their latest results. Propose at most five small, specific changes that the evidence supports. Proposing
nothing is better than guessing. Never propose new tools or permissions: that is the user's decision.
Do not repeat existing memory items or test questions. Do not put code fences inside a block.

Output only fenced blocks of these kinds:

\`\`\`remember
scope: <one of the agent's memory scopes>
<one or two sentences: a verified fact or lesson, and where it was verified>
\`\`\`

\`\`\`eval
why: <what this test guards against>
must_include: <comma-separated case-insensitive regexes the answer must match>
must_not_include: <optional, comma-separated regexes>
must_run: <optional, regexes a bash command the agent runs must match>
must_not_run: <optional, regexes no bash command may match>
max_tools: <optional integer>
<the exact question to ask the agent>
\`\`\`

\`\`\`instructions
why: <one line: which runs show the problem>
<the COMPLETE revised instruction text, without frontmatter>
\`\`\`

At most one instructions block, and only when instructions (not memory) are the cause.`;

/** Splits `key: value` header lines from the rest of a block. */
function headerAndBody(block) {
  const meta = {};
  const lines = block.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^(why|scope|must_include|must_not_include|must_run|must_not_run|max_tools):\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    meta[m[1]] = m[2].trim();
  }
  return { meta, body: lines.slice(i).join('\n').trim() };
}

export function parseProposals(text) {
  const out = { evals: [], instructions: [] };
  for (const m of (text ?? '').matchAll(/```(eval|instructions)\n([\s\S]*?)```/g)) {
    const { meta, body } = headerAndBody(m[2].trim());
    if (!body) continue;
    if (m[1] === 'eval') out.evals.push({ why: meta.why, include: list(meta.must_include), exclude: list(meta.must_not_include),
      run: list(meta.must_run), notRun: list(meta.must_not_run),
      maxTools: meta.max_tools ? Number(meta.max_tools) : null, question: body });
    else out.instructions.push({ why: meta.why, body });
  }
  return out;
}

function coachInput(agent, { root, state, runs }) {
  const memory = loadMemory(agent.memory, root);
  const recent = listRuns(state).filter((r) => r.agent === agent.name && ['task', 'chat'].includes(r.kind ?? 'task')).slice(-runs);
  const evalDirState = path.join(state, 'evals', agent.name);
  const lastEval = fs.existsSync(evalDirState) ? fs.readdirSync(evalDirState).filter((f) => f.endsWith('.json')).sort().at(-1) : undefined;
  const evalReport = lastEval ? JSON.parse(fs.readFileSync(path.join(evalDirState, lastEval), 'utf8')) : null;
  const cases = loadEvals(agent.name, root);
  return [
    `# Agent "${agent.name}" (version ${agent.version})`,
    `Tools: ${agent.tools.join(', ') || 'none'}. Memory scopes: ${agent.memory.join(', ')}.`,
    '## Current instructions', agent.instructions,
    '## Reviewed memory', memory.length ? memory.map((m) => `- (${m.meta.scope}) ${m.body.replace(/\n+/g, ' ')}`).join('\n') : '(none)',
    `## Recent runs (${recent.length})`,
    ...recent.map((r) => [
      `### ${r.run_id}${r.feedback ? ` — user rated ${r.feedback.rating.toUpperCase()}${r.feedback.comment ? `: ${r.feedback.comment}` : ''}` : ' — not rated'}`,
      `Task: ${r.task}`, `Tools used (${r.tool_calls.length}): ${r.tool_calls.join(', ') || 'none'}; tokens ${r.usage.totalTokens}; status ${r.status}`,
      r.kind === 'chat' ? `Chat (${r.turns} user message(s)):\n${(r.transcript ?? '').slice(-3000)}` : `Answer: ${(r.output ?? r.error ?? '').slice(0, 1500)}`,
      r.commands?.length ? `Commands: ${r.commands.map((c) => c.slice(0, 160)).join(' | ')}` : '',
      r.blocked?.length ? `BLOCKED by guard (tried anyway): ${r.blocked.map((c) => c.slice(0, 160)).join(' | ')}` : '',
    ].join('\n')),
    '## Test cases', cases.length ? cases.map((c) => {
      const res = evalReport?.results.find((x) => x.id === c.id);
      return `- ${c.question} → ${res ? (res.pass ? 'PASS' : `FAIL (${res.problems.join('; ')})`) : 'not run'}`;
    }).join('\n') : '(none yet; propose some that capture what the user cares about)',
  ].join('\n\n');
}

export async function reflect(name, { root = ROOT, state = STATE, runs = 10, spawn = nodeSpawn } = {}) {
  const agent = getAgent(name, root);
  const input = coachInput(agent, { root, state, runs });
  const args = ['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-context-files', '--no-skills',
    ...(agent.model ? ['--model', agent.model] : []), '--thinking', 'medium', '--system-prompt', COACH, '--', input];
  const events = await new Promise((resolve, reject) => {
    const child = spawn('pi', args, { cwd: state, stdio: ['ignore', 'pipe', 'pipe'] });
    const ev = []; let buf = '';
    child.stdout.on('data', (c) => { buf += c; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) if (l.trim()) { try { ev.push(JSON.parse(l)); } catch {} } });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => resolve(ev));
  });
  const summary = summarize(events);
  if (!summary.output) throw new Error(`coach produced no output${summary.error ? `: ${summary.error}` : ''}`);
  const reflectId = newId('r');
  const memoryIds = saveCandidates(extractRemember(summary.output, agent), { agent, runId: reflectId, root });
  const { evals, instructions } = parseProposals(summary.output);
  const dir = path.join(root, 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  const ids = [];
  for (const e of evals) {
    const id = newId('e');
    fs.writeFileSync(path.join(dir, `${id}.md`), formatFrontmatter({ id, kind: 'eval', agent: name, source: reflectId, why: e.why,
      must_include: e.include.join(', ') || undefined, must_not_include: e.exclude.join(', ') || undefined,
      must_run: e.run.join(', ') || undefined, must_not_run: e.notRun.join(', ') || undefined, max_tools: e.maxTools ?? undefined }, e.question));
    ids.push(id);
  }
  for (const ins of instructions.slice(0, 1)) {
    const id = newId('i');
    fs.writeFileSync(path.join(dir, `${id}.md`), formatFrontmatter({ id, kind: 'instructions', agent: name, base_version: agent.version, source: reflectId, why: ins.why }, ins.body));
    ids.push(id);
  }
  fs.mkdirSync(path.join(state, 'reflections'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, 'reflections', `${reflectId}.json`),
    JSON.stringify({ id: reflectId, agent: name, agent_version: agent.version, input, output: summary.output, usage: summary.usage, proposals: [...memoryIds, ...ids] }, null, 2) + '\n', { mode: 0o600 });
  return { reflectId, proposals: [...memoryIds, ...ids], usage: summary.usage, model: summary.model };
}

// ---------- review ----------

function listProposals(root) {
  const dir = path.join(root, 'proposals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => ({ file: path.join(dir, f), ...parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

export function pending(root = ROOT) {
  return [
    ...listCandidates(root).map((c) => ({ id: c.meta.id, kind: 'memory', agent: c.meta.proposed_by, why: c.meta.scope, body: c.body })),
    ...listProposals(root).map((p) => ({ id: p.meta.id, kind: p.meta.kind, agent: p.meta.agent, why: p.meta.why, body: p.body, meta: p.meta, file: p.file })),
  ];
}

/** Replaces only the instruction body of an agent file; its frontmatter text is kept byte for byte. */
export function replaceInstructions(text, body) {
  const m = /^(---\n[\s\S]*?\n---\n)/.exec(text);
  return (m ? m[1] : '') + body.trim() + '\n';
}

export function acceptProposal(id, { root = ROOT } = {}) {
  if (id.startsWith('m-')) {
    const dest = acceptCandidate(id, { root });
    commitHome(`Accept memory ${id}`, root);
    return dest;
  }
  const p = pending(root).find((x) => x.id === id);
  if (!p) throw new Error(`no proposal ${id}`);
  let dest;
  if (p.kind === 'eval') {
    const eid = addEval(p.agent, p.body, { include: list(p.meta.must_include), exclude: list(p.meta.must_not_include),
      run: list(p.meta.must_run), notRun: list(p.meta.must_not_run),
      maxTools: p.meta.max_tools ? Number(p.meta.max_tools) : null, why: p.meta.why, root });
    dest = path.join(evalDir(p.agent, root), `${eid}.md`);
  } else if (p.kind === 'instructions') {
    const agent = getAgent(p.agent, root);
    if (p.meta.base_version && p.meta.base_version !== agent.version) throw new Error(`${p.agent} changed since this proposal (was ${p.meta.base_version}, now ${agent.version}); reflect again`);
    fs.writeFileSync(agent.file, replaceInstructions(fs.readFileSync(agent.file, 'utf8'), p.body));
    dest = agent.file;
  } else throw new Error(`unknown kind ${p.kind}`);
  fs.rmSync(p.file);
  commitHome(`Accept ${p.kind} proposal ${id} for ${p.agent}${p.why ? `: ${p.why}` : ''}`, root);
  return dest;
}

export function rejectProposal(id, reason, { root = ROOT } = {}) {
  if (id.startsWith('m-')) { const d = rejectCandidate(id, { root, reason }); commitHome(`Reject memory ${id}`, root); return d; }
  const p = pending(root).find((x) => x.id === id);
  if (!p) throw new Error(`no proposal ${id}`);
  const dir = path.join(root, 'proposals', 'rejected');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(p.file));
  fs.writeFileSync(dest, formatFrontmatter({ ...p.meta, status: 'rejected', reason }, p.body));
  fs.rmSync(p.file);
  commitHome(`Reject ${p.kind} proposal ${id}`, root);
  return dest;
}

// ---------- CLI ----------

const flag = (args, name) => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };

export async function cli(cmd, args) {
  if (cmd === 'feedback') {
    const [ref, rating, ...comment] = args;
    const run = recordFeedback(ref, rating, comment.join(' '));
    console.log(`${run.run_id} rated ${rating}. The coach sees this on the next: agent reflect ${run.agent}`);
  } else if (cmd === 'eval' && args[0] === 'add') {
    const rest = args.slice(1);
    const include = list(flag(rest, '--include')); const exclude = list(flag(rest, '--exclude')); const max = flag(rest, '--max-tools');
    const run = list(flag(rest, '--run')); const notRun = list(flag(rest, '--not-run'));
    const [agent, ...q] = rest;
    getAgent(agent);
    console.log(addEval(agent, q.join(' '), { include, exclude, run, notRun, maxTools: max === undefined ? null : Number(max) }));
    commitHome(`Add eval case for ${agent}`);
  } else if (cmd === 'eval') {
    const { report, previous } = await runEvals(args[0]);
    for (const r of report.results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.question.slice(0, 70).padEnd(70)} tools=${r.tool_calls}${r.blocked.length ? ` blocked=${r.blocked.length}` : ''} ${r.problems.join('; ')}`);
    console.log(`\n${report.agent} v${report.agent_version}: ${report.passed}/${report.total} passed · ${report.tokens} tok · $${report.cost.toFixed(4)} · ${report.memory.length} note(s)`);
    if (previous) console.log(`previous (v${previous.agent_version}, ${previous.at.slice(0, 16)}): ${previous.passed}/${previous.total} passed · ${previous.tokens} tok · $${previous.cost.toFixed(4)}`);
  } else if (cmd === 'reflect') {
    const runs = Number(flag(args, '--runs') ?? 10);
    const r = await reflect(args[0], { runs });
    console.log(`coach (${r.model}, ${r.usage.totalTokens} tok, $${r.usage.cost.toFixed(4)}): ${r.proposals.length} proposal(s)${r.proposals.length ? ' — see: agent review' : ''}`);
  } else if (cmd === 'review') {
    const [sub, id, ...rest] = args;
    if (!sub) {
      const all = pending();
      if (!all.length) console.log('nothing waiting for review');
      for (const p of all) console.log(`${p.id}  ${p.kind.padEnd(12)} ${p.agent ?? ''}  ${p.why ?? ''}\n  ${p.body.replace(/\n+/g, ' ').slice(0, 160)}\n`);
    } else if (sub === 'show') {
      const p = pending().find((x) => x.id === id);
      if (!p) throw new Error(`no proposal ${id}`);
      console.log(`${p.kind} for ${p.agent}${p.why ? ` — ${p.why}` : ''}\n`);
      if (p.kind === 'instructions') {
        const agent = getAgent(p.agent);
        const tmp = path.join(STATE, 'proposal-preview.md');
        fs.writeFileSync(tmp, replaceInstructions(fs.readFileSync(agent.file, 'utf8'), p.body));
        process.stdout.write(spawnSync('diff', ['-u', agent.file, tmp], { encoding: 'utf8' }).stdout);
      } else console.log(formatFrontmatter(p.meta ?? {}, p.body));
    } else if (sub === 'accept') console.log(acceptProposal(id));
    else if (sub === 'reject') console.log(rejectProposal(id, rest.join(' ') || undefined));
    else throw new Error('usage: agent review [show|accept|reject <id>]');
  }
}
