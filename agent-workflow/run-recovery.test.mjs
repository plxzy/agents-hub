import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { save, read } from './durable-file.mjs';
import { RunJournal, loadCheckpoint, recoveryState, reconcileSession, fingerprint } from './run-recovery.mjs';
import { DevelopmentSessions } from './dev-sessions.mjs';

function fixture(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  for (const dir of ['agent-runs', 'agent-requests', 'recovery-v1']) fs.mkdirSync(path.join(state, dir));
  return state;
}
test('completed tool identities replay stored results; changed arguments cannot reuse an identity', async t => {
  const file = path.join(fixture(t), 'checkpoint.json'); let executions = 0;
  const j = new RunJournal(file, { remainingMs: 60000 });
  const execute = async () => { executions++; return { content: [{ type: 'text', text: 'done' }] }; };
  await j.tool('one', 'write', { path: 'a' }, execute);
  const resumed = new RunJournal(file, { previous: loadCheckpoint(file) });
  await resumed.tool('one', 'write', { path: 'a' }, execute);
  assert.equal(executions, 1);
  await assert.rejects(resumed.tool('one', 'write', { path: 'b' }, execute), /identity conflict/);
});

test('hard kill during a tool preserves intent: reads replay, writes require review', async t => {
  const dir = fixture(t), module = new URL('./run-recovery.mjs', import.meta.url).href;
  for (const name of ['read', 'write']) {
    const file = path.join(dir, name + '.json');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {RunJournal} from ${JSON.stringify(module)};
      const j = new RunJournal(${JSON.stringify(file)}, {remainingMs:60000});
      await j.tool('call', '${name}', {}, async()=>{process.stdout.write('started'); await new Promise(()=>{});});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.on('close', resolve));
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    child.kill('SIGKILL'); await closed;
    const cp = loadCheckpoint(file);
    assert.equal(recoveryState(cp), name === 'read' ? 'ready' : 'awaiting_review');
    let calls = 0; const j = new RunJournal(file, { previous: cp });
    const run = () => j.tool('call', name, {}, async () => { calls++; return { content: [] }; });
    if (name === 'write') { await assert.rejects(run(), /requires recovery review/); assert.equal(calls, 0); }
    else { await run(); assert.equal(calls, 1); }
  }
});

test('approved reconciliation records an uncertain write without replaying it', async t => {
  const j = new RunJournal(path.join(fixture(t), 'checkpoint.json'), { remainingMs: 60000 });
  await assert.rejects(j.tool('write-1', 'write', { path: 'a' }, async () => { throw Error('killed after partial write'); }));
  const messages = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'a' } }] }];
  const manager = { buildSessionContext: () => ({ messages }), appendMessage: m => messages.push(m) };
  const tools = [{ name: 'write', execute() { assert.fail('uncertain write must never be replayed'); } }];
  await assert.rejects(reconcileSession(manager, j, tools), /requires recovery review/);
  await reconcileSession(manager, j, tools, { approved: true });
  assert.equal(messages.at(-1).isError, true);
  assert.match(messages.at(-1).content[0].text, /may have partially/);
  await reconcileSession(manager, j, tools, { approved: true });
  assert.equal(messages.length, 2);
  // Simulate death after journalling the synthetic result, before appending to Pi history.
  messages.pop();
  await reconcileSession(manager, j, tools);
  assert.equal(messages.at(-1).isError, true);
});

test('journal enforces budgets, rejects corruption, and persists before tool effects', async t => {
  const dir = fixture(t); let now = 0, calls = 0;
  const j = new RunJournal(path.join(dir, 'checkpoint.json'), { remainingMs: 100, now: () => now });
  now = 100; j.update({});
  await assert.rejects(j.tool('x', 'read', {}, async () => { calls++; }), /budget exhausted/);
  assert.equal(calls, 0);
  fs.writeFileSync(j.file, '{partial'); assert.throws(() => loadCheckpoint(j.file));
  const bad = new RunJournal(path.join(dir, 'other.json'), { remainingMs: 100 });
  fs.rmSync(dir, { recursive: true });
  await assert.rejects(bad.tool('x', 'write', {}, async () => { calls++; }));
  assert.equal(calls, 0);
});

function hostFixture(t, { uncertain = false } = {}) {
  const state = fixture(t), id = 'r-20261013T000000Z-abcdef', workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace);
  const agent = { name: 'demo', version: 'same', tools: ['read', 'write'], workspace: '/repos/demo' };
  const host = Object.assign(Object.create(DevelopmentSessions.prototype), { state, revision: 'release', runs: new Map(),
    limits: { writeRuns: 2, runs: 2, autoRecovery: true }, room() {}, runnable: () => [agent], poolSlots: async () => ['openai'],
    report: async () => {}, executeRun: async () => {}, });
  const receipt = { run_id: id, request_id: 'original-request', root: id, agent: 'demo', repo: 'demo', write: true, task: 'Do work', status: 'interrupted' };
  save(path.join(state, 'agent-runs', id + '.json'), receipt);
  const dir = host.recoveryDir(id); fs.mkdirSync(dir);
  save(path.join(dir, 'setup.json'), { revision: 'release', agent, receipt, runtime: { provider: 'openai' }, config: { policy: { workspace }, manifest: {} } });
  const j = new RunJournal(path.join(dir, 'checkpoint.json'), { remainingMs: 60000 });
  j.update({ runtime: { provider: 'openai' } });
  if (uncertain) { j.value.tools[fingerprint('x')] = { name: 'write', state: 'started' }; j.update({}); }
  return { host, id, j, dir, receipt };
}

test('resume reserves capacity before await and repeated requests return the linked attempt', async t => {
  const { host, id, j } = hostFixture(t); let executions = 0;
  host.executeRun = async () => { executions++; };
  const args = { run_id: id, request_id: 'resume-request-one', checkpoint_version: j.value.version };
  const first = host.resumeRun(args);
  await assert.rejects(host.resumeRun({ ...args, request_id: 'resume-request-two' }), /busy/);
  const next = await first;
  assert.notEqual(next.run_id, id);
  assert.equal((await host.resumeRun(args)).run_id, next.run_id);
  assert.equal(executions, 1);
  assert.equal(host.runGet(id).status, 'interrupted');
  assert.equal(host.runGet(id).recovery.resumed_by, next.run_id);
  await assert.rejects(host.resumeRun({ ...args, checkpoint_version: args.checkpoint_version + 1 }), /identity conflict/);
});

test('stale approvals, missing accounts, changed policy and exhausted attempts pause safely', async t => {
  const { host, id, j, dir } = hostFixture(t, { uncertain: true });
  const args = { run_id: id, request_id: 'resume-request-one', checkpoint_version: j.value.version };
  await assert.rejects(host.resumeRun(args), /requires recovery review/);
  await assert.rejects(host.resumeRun({ ...args, checkpoint_version: 999 }, { approved: true }), /checkpoint changed/);
  save(path.join(dir, 'lifecycle.json'), { inspection: 'Inspected files; continue from current state.' });
  host.poolSlots = async () => [];
  await assert.rejects(host.resumeRun(args, { approved: true }), /account unavailable/);
  assert.equal(host.runs.size, 0);
  host.revision = 'changed'; assert.equal(host.recoveryInfo(id).info.state, 'paused'); host.revision = 'release';
  const setup = read(path.join(dir, 'setup.json')); save(path.join(dir, 'setup.json'), { ...setup, attempt: 2 });
  assert.equal(host.recoveryInfo(id).info.state, 'awaiting_review');
  await assert.rejects(host.resumeRun(args), /requires recovery review/);
  host.revision = 'changed';
  await assert.rejects(host.resumeRun(args, { approved: true }), /release changed/);
  host.revision = 'release'; j.update({ remaining_ms: 0 });
  await assert.rejects(host.resumeRun({ ...args, checkpoint_version: j.value.version }, { approved: true }), /budget exhausted/);
});

test('finished results can recover without another available model account', async t => {
  const { host, id, j, dir } = hostFixture(t);
  const setup = read(path.join(dir, 'setup.json')); setup.config.slots = ['openai']; save(path.join(dir, 'setup.json'), setup);
  j.update({ result: { output: 'Already finished', runtime: { provider: 'openai' } } });
  host.poolSlots = async () => { assert.fail('No model account is needed for a saved result'); };
  assert.ok((await host.resumeRun({ run_id: id, request_id: 'finished-resume', checkpoint_version: j.value.version })).run_id);
});

test('journal total size limit preserves the last durable intent', async t => {
  const file = path.join(fixture(t), 'checkpoint.json'), j = new RunJournal(file, { remainingMs: 60000 });
  await assert.rejects(j.tool('last', 'write', {}, async () => { j.value.padding = 'x'.repeat(16 * 1024 ** 2); return { content: [] }; }), /storage budget/);
  assert.equal(recoveryState(loadCheckpoint(file)), 'awaiting_review');
});
