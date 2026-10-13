import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  agentEnv, assertSandboxAllowed, commitHome, piCommand, acceptCandidate, addMemory, chatArgs, receiptFromSession, buildSystemPrompt, extractRemember, listCandidates, loadAgents,
  loadMemory, parseFrontmatter, formatFrontmatter, formatCandidateList, piArgs, rejectCandidate, runAgent, runChat, formatAgentListEntry, resolveWorkspace, sessionDirectory, sandboxProfile, listRuns,
} from './agent.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wf-'));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents/demo.md'),
    `---\nname: demo\ndescription: test agent\ntools: read, ls\nworkspace: ${root}\nmemory_scopes: shared, agent:demo\n---\nBe brief.\n`);
  return { root, state: path.join(root, '.state') };
}

function fakeSpawn(lines, calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      child.stdout.on('end', () => child.emit('close', 0));
      child.stdout.resume();
    });
    return child;
  };
}

const projectFixture = () => fs.mkdtempSync(new URL('./.agent-wf-test-', import.meta.url).pathname);

const reply = (text) => [
  { type: 'session', id: 'sess-1' },
  { type: 'tool_execution_start', toolName: 'ls' },
  { type: 'message_end', message: { role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'text', text }], usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } } } },
];

test('local receipt freezes start context across a branch and commit change, including Hub publication', async t => {
  const { root, state } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-q', '-b', 'start-branch'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-qm', 'initial');
  const base = git('rev-parse', 'HEAD'), sent = [];
  const spawn = (...args) => {
    git('checkout', '-qb', 'later-branch'); git('commit', '--allow-empty', '-qm', 'later');
    return fakeSpawn(reply('ok'), [])(...args);
  };
  const r = await runAgent('demo', 'fixture', { root, state, spawn, useMemory: false,
    hubConfig: { endpoint: 'https://hub.example', token: 'fixture-token' },
    fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json({}); } });
  assert.equal(r.checkout_branch, 'start-branch'); assert.equal(r.base_commit, base);
  assert.equal(r.commit, git('rev-parse', 'HEAD')); assert.notEqual(r.commit, base);
  assert.equal(r.worktree_dirty, false); assert.equal(r.logs.status, 'recorded');
  assert.equal(r.logs.location, r.raw_events);
  assert.equal(sent[0].checkout_branch, 'start-branch'); assert.equal(sent[0].base_commit, base);
  assert.equal(sent.at(-1).commit, r.commit); assert.equal(sent.at(-1).logs.status, 'recorded');
  assert.equal(sent.at(-1).workspace, undefined); assert.equal(sent.at(-1).logs.location, undefined);
});

test('local failed run keeps previous assistant output and publishes failure context', async t => {
  const { root, state } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [...reply('Read the configuration.'), { type: 'message_end', message: {
    role: 'assistant', provider: 'openai', model: 'gpt-6-luna', content: [], stopReason: 'error', errorMessage: '503 service unavailable',
  } }];
  const r = await runAgent('demo', 'fixture', { root, state, spawn: fakeSpawn(events, []), hubConfig: null });
  assert.equal(r.status, 'failed'); assert.equal(r.output, 'Read the configuration.');
  assert.equal(r.output_partial, true); assert.equal(r.failure_context.last_tool, 'ls');
  assert.equal(r.failure_context.message, '503 service unavailable');
  assert.equal(r.memory_proposed.length, 0);
});

test('local running markers expose tool progress before completion and retain it in the final receipt', async t => {
  const { root, state } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let signal, close, child;
  const ready = new Promise(resolve => { signal = resolve; });
  const running = runAgent('demo', 'fixture', { root, state, hubConfig: null, spawn: () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: '/private/file' } }) + '\n');
      close = () => { child.stdout.end(JSON.stringify({ type: 'tool_execution_end', toolName: 'read', isError: false })); child.emit('close', 0); };
      signal();
    }); return child;
  } });
  await ready;
  const live = listRuns(state, { running: true })[0];
  assert.equal(live.status, 'running'); assert.equal(live.progress.action, 'tool_started');
  assert.equal(live.progress.last_tool, 'read'); assert.doesNotMatch(JSON.stringify(live.progress), /private/);
  close(); const final = await running;
  assert.equal(final.progress.action, 'tool_completed');
  assert.equal(listRuns(state, { running: true })[0].status, 'completed');
});

test('nested sandbox launches fail before spawning or writing run state', async (t) => {
  const { root, state } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = process.env.AGENT_SANDBOXED;
  t.after(() => { if (original === undefined) delete process.env.AGENT_SANDBOXED; else process.env.AGENT_SANDBOXED = original; });
  const agent = loadAgents(root)[0];
  agent.writePaths = [root];
  assert.equal(agentEnv(agent).AGENT_SANDBOXED, '1');
  assertSandboxAllowed(agent, 'agent chat demo', {});
  process.env.AGENT_SANDBOXED = '1';
  assert.throws(() => piCommand(agent, []), /cannot start a sandboxed agent from inside a sandbox/);
  assert.throws(() => assertSandboxAllowed(agent, 'agent chat demo'), /ask the user to run: agent chat demo/);
  assert.deepEqual(piCommand({ ...agent, writePaths: null }, []), ['pi', []]);
  fs.writeFileSync(agent.file, `---\nname: demo\nworkspace: ${root}\nwrite_paths: ${root}\n---\nBe brief.\n`);
  await assert.rejects(runAgent('demo', 'q', { root, state, spawn: () => assert.fail('must not spawn') }), /ask the user to run: agent run demo "q"/);
  assert.equal(fs.existsSync(state), false);
});

test('commitHome excludes pending candidates, including already staged changes', (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(root, 'memory/candidates'), { recursive: true });
  const candidate = path.join(root, 'memory/candidates/pending.md');
  fs.writeFileSync(candidate, 'old');
  git('add', '-A'); git('commit', '-qm', 'initial');
  fs.writeFileSync(candidate, 'pending');
  fs.writeFileSync(path.join(root, 'memory/candidates/new.md'), 'new');
  git('add', '-A');
  fs.appendFileSync(path.join(root, 'agents/demo.md'), 'Changed.\n');
  assert.equal(commitHome('definition only', root), true);
  assert.equal(git('show', 'HEAD:memory/candidates/pending.md').stdout, 'old');
  assert.notEqual(git('show', 'HEAD:memory/candidates/new.md').status, 0);
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'pending');
  assert.equal(git('diff', '--cached', '--name-only').stdout, '');
});

test('parses frontmatter lists and scalars', () => {
  const { meta, body } = parseFrontmatter('---\na: 1\nb: [x, y]\n---\nhello\n');
  assert.deepEqual(meta, { a: '1', b: ['x', 'y'] });
  assert.equal(body, 'hello');
});

test('loads agent definitions', () => {
  const { root } = fixture();
  const [a] = loadAgents(root);
  assert.equal(a.name, 'demo');
  assert.deepEqual(a.tools, ['read', 'ls']);
  assert.deepEqual(a.memory, ['shared', 'agent:demo']);
});

test('agent list entry includes optional guard, skill names, and write paths compactly', () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, 'agents/demo.md'),
    `---\nname: demo\ndescription: test agent\ntools: read, ls\nmemory_scopes: shared\nguard: readonly\nskills: helper, network\nwrite_paths: ~/Development/demo\nhere_write: AGENTS.md, .agents\n---\nBe brief.\n`);
  const entry = formatAgentListEntry(loadAgents(root)[0]);
  assert.match(entry, /guard=readonly/);
  assert.match(entry, /skills=helper,network/);
  assert.match(entry, /here_write=AGENTS\.md,\.agents/);
  assert.ok(entry.includes('writes=') && entry.includes('/Development/demo'));
  assert.equal((entry.match(/\n/g) ?? []).length, 1);
});

test('remember blocks only target the agent\'s own scopes', () => {
  const agent = { name: 'demo', memory: ['shared', 'agent:demo'] };
  const got = extractRemember('ok\n```remember\nscope: shared\nA\n```\n```remember\nscope: project:other\nB\n```\n```remember\nC\n```', agent);
  assert.deepEqual(got, [
    { scope: 'shared', body: 'A' },
    { scope: 'agent:demo', body: 'B' },
    { scope: 'agent:demo', body: 'C' },
  ]);
});

test('run records a receipt, proposes candidates, and review controls what later runs see', async () => {
  const { root, state } = fixture();
  const calls = [];
  const r1 = await runAgent('demo', 'q1', { root, state, spawn: fakeSpawn(reply('answer\n```remember\nThe sky is blue (checked).\n```'), calls) });
  assert.equal(r1.status, 'completed');
  assert.equal(r1.session_id, 'sess-1');
  assert.deepEqual(r1.tool_calls, ['ls']);
  assert.deepEqual(r1.memory_supplied, []);
  assert.equal(r1.memory_proposed.length, 1);
  assert.ok(fs.existsSync(path.join(state, 'runs', `${r1.run_id}.json`)));
  assert.equal(calls[0].opts.cwd, root);
  assert.ok(calls[0].args.includes('read,ls'));

  // Unreviewed candidates are never supplied.
  assert.deepEqual(loadMemory(['agent:demo'], root), []);
  const [cand] = listCandidates(root);
  acceptCandidate(cand.meta.id, { root });
  const r2 = await runAgent('demo', 'q2', { root, state, spawn: fakeSpawn(reply('again'), calls) });
  assert.deepEqual(r2.memory_supplied, [cand.meta.id]);
  assert.match(calls[1].args[calls[1].args.indexOf('--append-system-prompt') + 1], /The sky is blue/);
});

test('linked task publishes running before spawn, then the same id as completed or failed', async (t) => {
  const { root, state } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posted = [], hubConfig = { endpoint: 'https://hub.example', token: 'test-only' };
  const fetchImpl = async (_url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  const inner = fakeSpawn(reply('done'), []);
  const result = await runAgent('demo', 'live test', { root, state, hubConfig, fetchImpl, useMemory: false,
    spawn: (...args) => { assert.equal(posted.at(-1).status, 'running'); return inner(...args); } });
  assert.deepEqual(posted.map(r => r.status), ['running', 'completed']);
  assert.equal(posted[0].run_id, result.run_id); assert.equal(posted[1].run_id, result.run_id);
  assert.equal(posted[0].started, posted[1].started);
  posted.length = 0;
  await assert.rejects(runAgent('demo', 'spawn error', { root, state, hubConfig, fetchImpl, useMemory: false,
    spawn: () => { throw new Error('spawn refused'); } }), /spawn refused/);
  assert.deepEqual(posted.map(r => r.status), ['running', 'failed']);
  assert.match(posted[1].error, /spawn refused/);
  assert.equal(fs.existsSync(path.join(state, 'runs', `${posted[0].run_id}.running`)), false);
});

test('offline task queues only its terminal receipt', async (t) => {
  const { root, state } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = await runAgent('demo', 'offline', { root, state, useMemory: false,
    hubConfig: { endpoint: 'https://hub.example', token: 'test-only' }, fetchImpl: async () => { throw new Error('offline'); },
    spawn: fakeSpawn(reply('done'), []) });
  const queued = JSON.parse(fs.readFileSync(path.join(state, 'hub-outbox', `${r.run_id}.json`), 'utf8'));
  assert.equal(queued.status, 'completed');
  assert.deepEqual(fs.readdirSync(path.join(state, 'hub-outbox')), [`${r.run_id}.json`]);
});

test('interactive chats replace their live row, including empty exits and spawn failures', async (t) => {
  const { root, state } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hubConfig = { endpoint: 'https://hub.example', token: 'test-only' }, posted = [];
  const fetchImpl = async (url, init) => {
    if (init.body) posted.push(JSON.parse(init.body));
    return { ok: true, json: async () => url.includes('bundle') ? { memory: [], hash: 'test' } : {} };
  };
  const spawnChat = (write) => (_cmd, args) => {
    assert.equal(posted.at(-1).status, 'running');
    const child = new EventEmitter();
    setImmediate(() => {
      if (write) fs.writeFileSync(path.join(args[args.indexOf('--session-dir') + 1], 'session.jsonl'), [
        { type: 'message', message: { role: 'user', content: 'hello', timestamp: Date.now() } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() } },
      ].map(x => JSON.stringify(x)).join('\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const opts = { root, state, hubConfig, fetchImpl, log() {} };
  for (const [write, status] of [[true, 'completed'], [false, 'interrupted']]) {
    posted.length = 0;
    const [receipt] = await runChat('demo', { ...opts, spawn: spawnChat(write) });
    assert.deepEqual(posted.map(r => r.status), ['running', status]);
    assert.equal(posted[0].run_id, receipt.run_id); assert.equal(posted[1].run_id, receipt.run_id);
    assert.equal(fs.existsSync(path.join(state, 'runs', `${receipt.run_id}.running`)), false);
  }
  posted.length = 0;
  await assert.rejects(runChat('demo', { ...opts, spawn: () => { throw new Error('chat spawn refused'); } }), /chat spawn refused/);
  assert.deepEqual(posted.map(r => r.status), ['running', 'failed']);
});

test('superseded and rejected items are not supplied', async () => {
  const { root, state } = fixture();
  const agent = loadAgents(root)[0];
  const spawn = fakeSpawn(reply('x\n```remember\nold fact\n```\n```remember\nnew fact\n```\n```remember\nbad fact\n```'), []);
  await runAgent('demo', 'q', { root, state, spawn });
  const idOf = (body) => listCandidates(root).find((i) => i.body === body).meta.id;
  const [a, b, c] = ['old fact', 'new fact', 'bad fact'].map(idOf);
  acceptCandidate(a, { root });
  acceptCandidate(b, { root, supersedes: a });
  rejectCandidate(c, { root, reason: 'wrong' });
  const ids = loadMemory(agent.memory, root).map((m) => m.meta.id);
  assert.deepEqual(ids, [b]);
  assert.match(buildSystemPrompt(agent, loadMemory(agent.memory, root)), /new fact/);
});

test('candidate list is numbered, spaced, wrapped, and includes review context', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const item = (id, created, body) => ({ meta: { id, created, scope: 'shared', proposed_by: 'demo', source_run: 'r-demo' }, body });
  const output = formatCandidateList([
    item('m-first-abcdef', '2026-10-10T10:00:00Z', 'A long note with evidence. '.repeat(10).trim()),
    item('m-second-123456', '2026-10-10T11:57:00Z', 'Second\nnote.'),
  ], now);
  assert.match(output, /^2 candidates waiting for review\n\n1\. abcdef · shared · proposed by demo · 2h ago\n   source run: r-demo\n/);
  assert.match(output, /\n\n2\. 123456 .*3m ago\n   source run: r-demo\n    Second note\./);
  assert.ok(output.split('\n').filter((l) => l.startsWith('    ')).every((l) => l.length <= 90));
  assert.ok(output.endsWith('agent memory accept <n|id> · agent memory reject <n|id> [reason]'));
  assert.match(formatCandidateList([], now), /^0 candidates waiting for review\n\nagent memory accept/);
  assert.match(formatCandidateList([item('m-x-abcdef', 'invalid', 'Note')], now), /^1 candidate waiting for review[\s\S]*age unknown/);
  for (const [offset, age] of [[86400000, '1d'], [10000, '10s'], [-1000, '0s']]) {
    assert.ok(formatCandidateList([item('m-x-abcdef', new Date(now - offset).toISOString(), 'Note')], now).includes(`${age} ago`));
  }
});

function candidateFixture(root, ids) {
  const dir = path.join(root, 'memory/candidates');
  fs.mkdirSync(dir, { recursive: true });
  for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.md`), formatFrontmatter({
    id, scope: 'agent:demo', proposed_by: 'demo', source_run: 'r-demo', created: '2026-10-10T10:00:00Z', status: 'candidate',
  }, `Note ${id}`));
}

test('accept/reject resolve full ids, suffixes and current numbers without renaming notes', (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ids = ['m-a-abcdef', 'm-b-123456', 'm-c-fedcba', 'm-d-654321'];
  candidateFixture(root, ids);
  const accepted = acceptCandidate('ABCDEF', { root, scope: 'shared', supersedes: 'm-old' });
  assert.equal(path.basename(accepted), `${ids[0]}.md`);
  assert.equal(loadMemory(['shared'], root)[0].meta.supersedes, 'm-old');
  const rejected = rejectCandidate('2', { root, reason: 'not useful' });
  assert.equal(path.basename(rejected), `${ids[2]}.md`);
  assert.equal(parseFrontmatter(fs.readFileSync(rejected, 'utf8')).meta.reason, 'not useful');
  assert.equal(path.basename(acceptCandidate(ids[1], { root })), `${ids[1]}.md`);
  assert.equal(path.basename(rejectCandidate('654321', { root })), `${ids[3]}.md`);
  for (const selector of ['0', '-1', '1', 'abc', undefined]) {
    assert.throws(() => acceptCandidate(selector, { root }), /no candidate/);
  }
});

test('ambiguous suffixes are refused without modifying candidates; full ids still work', (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ids = ['m-a-abcdef', 'm-b-abcdef'];
  candidateFixture(root, ids);
  assert.throws(() => acceptCandidate('abcdef', { root }), /ambiguous candidate.*full id/);
  assert.throws(() => rejectCandidate('abcdef', { root }), /ambiguous candidate/);
  assert.deepEqual(listCandidates(root).map((c) => c.meta.id), ids);
  acceptCandidate(ids[0], { root });
  rejectCandidate('abcdef', { root });
});

test('memory CLI lists candidates and keeps accept flags and reject reasons working', (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ids = ['m-a-abcdef', 'm-b-fedcba'];
  candidateFixture(root, ids);
  const cli = (...args) => spawnSync(process.execPath, [new URL('./agent.mjs', import.meta.url).pathname, ...args],
    { encoding: 'utf8', env: { ...process.env, AGENT_HOME: root } });
  const listed = cli('memory');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /2 candidates waiting for review\n\n1\. abcdef/);
  assert.match(cli().stdout, /accept <n\|id>[\s\S]*unique 6-hex suffix/);
  const accepted = cli('memory', 'accept', '1', '--scope', 'shared', '--supersedes', 'm-old');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim(), `memory/shared/${ids[0]}.md`);
  assert.equal(loadMemory(['shared'], root)[0].meta.supersedes, 'm-old');
  const rejected = cli('memory', 'reject', 'fedcba', 'wrong', 'scope');
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(parseFrontmatter(fs.readFileSync(path.join(root, 'memory/rejected', `${ids[1]}.md`), 'utf8')).meta.reason, 'wrong scope');
});

test('continue flag resumes the agent session', () => {
  const agent = { tools: [], model: null, thinking: null };
  const args = piArgs(agent, { task: 't', prompt: 'p', sessionDir: '/s', resume: true });
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('--no-tools'));
});

test('user-written notes are active immediately; chat args mirror run args', () => {
  const { root } = fixture();
  const agent = loadAgents(root)[0];
  addMemory('agent:demo', 'Prefer short answers.', { root });
  assert.match(buildSystemPrompt(agent, loadMemory(agent.memory, root)), /Prefer short answers/);
  const args = chatArgs(agent, { prompt: 'p', sessionDir: '/s', resume: false });
  assert.ok(!args.includes('-p') && !args.includes('--mode'));
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'read,ls']);
});

test('a chat session file becomes a rateable run', () => {
  const lines = [
    { type: 'session', id: 's' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 } },
    { type: 'message', message: { role: 'assistant', provider: 'p', model: 'm', timestamp: 2, usage: { totalTokens: 5, cost: { total: 0.01 } },
      content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }, { type: 'text', text: 'hello' }] } },
  ].map((x) => JSON.stringify(x)).join('\n');
  const r = receiptFromSession(lines, { agent: { name: 'demo', tools: [], version: 'v' } });
  assert.equal(r.kind, 'chat'); assert.equal(r.task, 'hi'); assert.equal(r.output, 'hello');
  assert.deepEqual(r.commands, ['ls']); assert.equal(r.usage.cost, 0.01);
});

test('here workspaces are canonical, bounded by home, and have run-local permissions', (t) => {
  const dir = projectFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(project, alias);
  const agent = { name: 'demo', workspace: 'here', writePaths: ['/other'] };
  const resolved = resolveWorkspace(agent, alias);
  assert.equal(resolved.workspace, fs.realpathSync(project));
  assert.deepEqual(resolved.writePaths, ['/other', resolved.workspace]);
  assert.equal(sessionDirectory(resolved), sessionDirectory(resolveWorkspace(agent, project)));
  assert.notEqual(sessionDirectory(resolved), sessionDirectory(resolveWorkspace(agent, dir)));
  assert.notEqual(sessionDirectory(resolved), sessionDirectory(resolved, undefined, 'eval'));
  assert.match(sessionDirectory(resolved), /demo\.[a-f0-9]{12}$/);
  assert.deepEqual(agent, { name: 'demo', workspace: 'here', writePaths: ['/other'] });
  assert.throws(() => resolveWorkspace(agent, os.homedir()), /strictly inside/);
  assert.throws(() => resolveWorkspace(agent, path.parse(os.homedir()).root), /strictly inside/);
  const outside = path.join(dir, 'outside');
  fs.symlinkSync(path.parse(os.homedir()).root, outside);
  assert.throws(() => resolveWorkspace(agent, outside), /strictly inside/);
  const file = path.join(dir, 'file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => resolveWorkspace(agent, file), /directory/);
  const fixed = { ...agent, workspace: project };
  assert.equal(resolveWorkspace(fixed, '/ignored'), fixed);
  assert.equal(sessionDirectory(fixed, '/state'), '/state/sessions/demo');
});

test('here_write parses lists, restricts run-local grants, and rejects escaping paths', (t) => {
  const { root } = fixture();
  const dir = projectFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(root, 'agents/demo.md');
  const define = (value) => fs.writeFileSync(file, `---\nname: demo\nworkspace: here\nwrite_paths: /other\nhere_write: ${value}\n---\nBe brief.\n`);
  for (const value of ['AGENTS.md, .agents', '[AGENTS.md, .agents]']) {
    define(value);
    const agent = loadAgents(root)[0];
    assert.deepEqual(agent.hereWrite, ['AGENTS.md', '.agents']);
    assert.deepEqual(resolveWorkspace(agent, dir).writePaths,
      ['/other', path.join(dir, 'AGENTS.md'), path.join(dir, '.agents')]);
    assert.deepEqual(agent.writePaths, ['/other']);
    const fixed = { ...agent, workspace: dir };
    assert.equal(resolveWorkspace(fixed), fixed);
  }
  for (const value of ['/absolute', '..', '../outside', '.agents/../../outside']) {
    define(value);
    assert.throws(() => loadAgents(root), /here_write.*relative.*inside/);
    assert.throws(() => resolveWorkspace({ workspace: 'here', hereWrite: [value] }, dir), /here_write/);
  }
  define('');
  const empty = loadAgents(root)[0];
  assert.deepEqual(resolveWorkspace(empty, dir).writePaths, ['/other']);
  assert.match(formatAgentListEntry(empty), /here_write=none/);
});

test('here_write sandbox permits new exact files and directories but denies unlisted writes',
  { skip: process.platform !== 'darwin' }, (t) => {
    // This fixture is inside home: /tmp would not exercise the home-folder write denial.
    const dir = projectFixture();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const agent = resolveWorkspace({ workspace: 'here', hereWrite: ['AGENTS.md', '.agents'] }, dir);
    const profile = sandboxProfile(agent);
    const run = (script, ...args) => spawnSync('sandbox-exec', ['-p', profile, process.execPath, '-e', script, ...args],
      { encoding: 'utf8' });
    const file = path.join(dir, 'AGENTS.md');
    assert.equal(fs.existsSync(file), false);
    const allowed = run("const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'new'); fs.mkdirSync(process.argv[2]); fs.writeFileSync(process.argv[2] + '/skill.md', 'nested');",
      file, path.join(dir, '.agents'));
    if (allowed.status === 71 && allowed.stderr.includes('sandbox_apply: Operation not permitted')) {
      t.skip('this environment prohibits sandbox-exec; run from an unsandboxed terminal');
      return;
    }
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(dir, '.agents/skill.md'), 'utf8'), 'nested');
    for (const name of ['other.md', 'AGENTS.md-extra', '.agents-extra']) {
      const denied = run("require('node:fs').writeFileSync(process.argv[1], 'denied')", path.join(dir, name));
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /EPERM|EACCES|Operation not permitted/);
      assert.equal(fs.existsSync(path.join(dir, name)), false);
    }
  });

test('here runs sandbox the actual folder, record it, and continue only its history', async (t) => {
  const { root, state } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = projectFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, 'agents/demo.md'), '---\nname: demo\nworkspace: here\n---\nBe brief.\n');
  const calls = [];
  const options = { root, state, resume: true, spawn: fakeSpawn(reply('ok'), calls) };
  const first = await runAgent('demo', 'q', { ...options, cwd: dir });
  await runAgent('demo', 'q', { ...options, cwd: dir });
  await runAgent('demo', 'q', { ...options, cwd: other });
  const session = (call) => call.args[call.args.indexOf('--session-dir') + 1];
  assert.equal(session(calls[0]), session(calls[1]));
  assert.notEqual(session(calls[0]), session(calls[2]));
  assert.ok(calls[0].args.includes('-c'));
  assert.equal(calls[0].cmd, 'sandbox-exec');
  assert.ok(calls[0].args[1].includes(`(subpath ${JSON.stringify(fs.realpathSync(dir))})`));
  assert.equal(first.workspace, fs.realpathSync(dir));
  assert.equal(calls[0].opts.cwd, first.workspace);
  assert.equal(loadAgents(root)[0].writePaths, null);
  const chatReceipt = receiptFromSession(JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
    { agent: resolveWorkspace(loadAgents(root)[0], dir) });
  assert.equal(chatReceipt.workspace, first.workspace);
  const defaultRun = await runAgent('demo', 'q', options);
  assert.equal(defaultRun.workspace, fs.realpathSync(process.cwd()));
  await assert.rejects(runAgent('demo', 'q', { ...options, cwd: os.homedir() }), /strictly inside/);
  assert.equal(calls.length, 4);
});

test('agents with write_paths run Pi in a sandbox that only allows those writes', async () => {
  const { piCommand, sandboxProfile } = await import('./agent.mjs');
  const agent = { writePaths: ['/h/repo'], file: '/h/.agents/agents/w.md', sudoAllow: [], protectPaths: [] };
  const [cmd, args] = piCommand(agent, ['-p', 'x']);
  assert.equal(cmd, 'sandbox-exec');
  assert.deepEqual(args.slice(2), ['pi', '-p', 'x']);
  const profile = sandboxProfile(agent, { home: '/h', state: '/h/.state' });
  assert.match(profile, /\(deny file-write\* \(subpath "\/h"\)\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/h\/repo"\)/);
  assert.match(profile, /\(deny file-read\* file-write\* .*"\/h\/.codex\/auth.json"/);
  assert.deepEqual(piCommand({ ...agent, writePaths: null }, ['-p']), ['pi', ['-p']]);
});

