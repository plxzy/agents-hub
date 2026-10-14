import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { linuxPolicy, sandboxExecute } from './linux-sandbox.mjs';
import { RunJournal, loadCheckpoint, recoveryState, reconcileSession } from './run-recovery.mjs';
import { DevelopmentSessions } from './dev-sessions.mjs';
import { save, read } from './durable-file.mjs';

const linux = { skip: process.platform !== 'linux' || process.env.AGENT_TEST_LINUX !== '1', timeout: 45000 };
test('real Pi history and Linux sandbox survive a killed mutating tool without replay', linux, async t => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.local/state/recovery-acceptance-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace'); fs.mkdirSync(workspace);
  const policy = linuxPolicy({ workspace, writePaths: [workspace], skills: 'none' }, path.join(base, 'state'));
  const sdk = await import(policy.sdk), sessions = path.join(base, 'sessions');
  const manager = sdk.SessionManager.create(workspace, sessions, { id: 'recovery-linux-test' });
  const command = 'echo once >> effects; sleep 30';
  manager.appendMessage({ role: 'user', content: 'Write once', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'partial', name: 'bash', arguments: { command } }],
    api: 'openai-responses', provider: 'openai', model: 'fixture', stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
  const file = path.join(base, 'checkpoint.json');
  const j = new RunJournal(file, { remainingMs: 60000 }); j.session(manager);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { RunJournal, loadCheckpoint } from ${JSON.stringify(new URL('./run-recovery.mjs', import.meta.url).href)};
    import { sandboxExecute } from ${JSON.stringify(new URL('./linux-sandbox.mjs', import.meta.url).href)};
    const j = new RunJournal(${JSON.stringify(file)}, { previous: loadCheckpoint(${JSON.stringify(file)}) });
    await j.tool('partial','bash',${JSON.stringify({ command })},()=>sandboxExecute(${JSON.stringify(policy)},'bash',${JSON.stringify({ command })}));
  `], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.on('close', resolve));
  t.after(() => child.kill('SIGKILL'));
  for (let n = 0; n < 100 && !fs.existsSync(path.join(workspace, 'effects')); n++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(path.join(workspace, 'effects')));
  child.kill('SIGKILL'); await closed;
  const cp = loadCheckpoint(file); assert.equal(recoveryState(cp), 'awaiting_review');
  const restored = sdk.SessionManager.open(cp.session_file, sessions, workspace);
  const next = new RunJournal(path.join(base, 'next.json'), { previous: cp });
  await assert.rejects(reconcileSession(restored, next, []), /requires recovery review/);
  assert.match(JSON.stringify(await sandboxExecute({ ...policy, readonly_workspace: true }, 'read', { path: 'effects' })), /once/);
  assert.throws(() => sandboxExecute({ ...policy, readonly_workspace: true }, 'write', { path: 'effects', content: 'bad' }), /Read-only/);
  await reconcileSession(restored, next, [], { approved: true });
  assert.equal(restored.buildSessionContext().messages.at(-1).isError, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'effects'), 'utf8'), 'once\n');
});

test('boot repairs a linked resume intent and never allocates a second successor', linux, async t => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.local/state/recovery-boot-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const state = path.join(base, 'state'), knowledge = path.join(base, 'knowledge'), repository = path.join(base, 'repo.git');
  for (const dir of [state, knowledge, repository]) fs.mkdirSync(dir);
  save(path.join(knowledge, 'RELEASE.json'), { files: {} });
  const prior = 'r-20261013T000000Z-abcdef', next = 'r-20261013T000001Z-123abc';
  for (const id of [prior, next]) fs.mkdirSync(path.join(state, 'recovery-v1', id), { recursive: true });
  save(path.join(state, 'recovery-v1', prior, 'lifecycle.json'), { resumed_by: next });
  const receipt = { run_id: next, request_id: 'linked-request', status: 'running' };
  save(path.join(state, 'recovery-v1', next, 'setup.json'), { receipt, request_fingerprint: 'stable' });
  const config = { state, knowledge, repository, revision: 'fixture' };
  new DevelopmentSessions(config);
  assert.equal(read(path.join(state, 'agent-requests', 'linked-request.json')).run_id, next);
  assert.equal(read(path.join(state, 'agent-runs', next + '.json')).status, 'interrupted');
  new DevelopmentSessions(config);
  assert.deepEqual(fs.readdirSync(path.join(state, 'agent-runs')), [next + '.json']);
});
