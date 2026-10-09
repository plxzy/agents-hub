import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  acceptCandidate, addMemory, chatArgs, receiptFromSession, buildSystemPrompt, extractRemember, listCandidates, loadAgents,
  loadMemory, parseFrontmatter, piArgs, rejectCandidate, runAgent, formatAgentListEntry, resolveWorkspace, sessionDirectory,
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
    `---\nname: demo\ndescription: test agent\ntools: read, ls\nmemory_scopes: shared\nguard: readonly\nskills: helper, network\nwrite_paths: ~/Development/demo\n---\nBe brief.\n`);
  const entry = formatAgentListEntry(loadAgents(root)[0]);
  assert.match(entry, /guard=readonly/);
  assert.match(entry, /skills=helper,network/);
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
