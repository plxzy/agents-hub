import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { save, read } from './durable-file.mjs';
import { RunJournal, loadCheckpoint, recoveryState, reconcileSession, fingerprint } from './run-recovery.mjs';
import { DevelopmentSessions } from './dev-sessions.mjs';
import { recoveryAction, recoveryEligible } from './recovery-contract.mjs';

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

const modelFailure = { status: 'failed', error: 'model turn failed', failure_context: {
  phase: 'model', message: 'OpenAI Responses stream ended before a terminal response event' } };

test('failed transport turns resume retained files without changing the original failure', async t => {
  const { host, id, j, receipt } = hostFixture(t);
  save(path.join(host.state, 'agent-runs', id + '.json'), { ...receipt, ...modelFailure });
  fs.writeFileSync(path.join(host.state, 'workspace', 'partial.txt'), 'saved edits');
  const info = host.recoveryInfo(id).info;
  assert.equal(recoveryAction({ ...modelFailure, recovery: info }), 'resume_run');
  let config;
  host.executeRun = async (_a, _r, _receipt, _p, recovery) => { config = recovery.setup.config; };
  const next = await host.resumeRun({ run_id: id, request_id: 'failed-resume', checkpoint_version: j.value.version });
  assert.equal(next.recovery.resumed_from, id);
  assert.equal(host.runGet(id).status, 'failed');
  assert.equal(fs.readFileSync(path.join(config.policy.workspace, 'partial.txt'), 'utf8'), 'saved edits');
  assert.equal(config.recover_from, j.file);
});

test('automatic failed recovery requires a new failure marker and stops after two attempts', async t => {
  const { host, id, receipt, dir } = hostFixture(t);
  save(path.join(host.state, 'agent-runs', id + '.json'), { ...receipt, ...modelFailure });
  let starts = 0;
  host.executeRun = async () => { starts++; };
  await host.recoverPending();
  assert.equal(starts, 0, 'upgrade must not revive historical failures');
  save(path.join(dir, 'lifecycle.json'), { automatic_eligible: true });
  const setup = read(path.join(dir, 'setup.json'));
  save(path.join(dir, 'setup.json'), { ...setup, attempt: 2 });
  await host.recoverPending();
  assert.equal(starts, 0);
  assert.match(host.runGet(id).recovery.reason, /attempt limit/);
  save(path.join(dir, 'setup.json'), { ...setup, attempt: 0 });
  await host.recoverPending();
  assert.equal(starts, 1);
  await host.recoverPending();
  assert.equal(starts, 1, 'resumed original is not admitted again');
});

test('unsafe failures never become eligible from task text or a ready checkpoint', async t => {
  const { host, id, j, receipt } = hostFixture(t);
  for (const error of ['Execution lease refused', 'Run time limit exceeded', 'model turn failed']) {
    const r = { ...receipt, status: 'failed', error, task: modelFailure.failure_context.message };
    save(path.join(host.state, 'agent-runs', id + '.json'), r);
    assert.equal(recoveryEligible(r), false);
    assert.equal(recoveryAction({ ...r, recovery: { state: 'ready', retained: true, checkpoint_version: 1 } }), null);
    assert.equal(host.recoveryInfo(id).info.state, 'paused');
    await assert.rejects(host.resumeRun({ run_id: id, request_id: 'unsafe-resume', checkpoint_version: j.value.version }), /operator inspection/);
  }
});

test('provider overload is a retryable model failure; quota and refusals are not', () => {
  const failed = message => ({ status: 'failed', error: 'model turn failed', failure_context: { phase: 'model', message } });
  for (const message of ['Our servers are currently overloaded. Please try again later.', '529 Overloaded'])
    assert.equal(recoveryEligible(failed(message)), true, message);
  for (const message of ['429 You exceeded your current quota', 'Request refused', 'overloaded'])
    assert.equal(recoveryEligible(failed(message)), false, message);
});

test('failed transport recovery still refuses uncertain tools and missing workspaces', async t => {
  const { host, id, j, receipt } = hostFixture(t, { uncertain: true });
  save(path.join(host.state, 'agent-runs', id + '.json'), { ...receipt, ...modelFailure });
  assert.equal(host.recoveryInfo(id).info.state, 'awaiting_review');
  await assert.rejects(host.resumeRun({ run_id: id, request_id: 'uncertain-failed', checkpoint_version: j.value.version }), /requires recovery review/);
  fs.rmSync(path.join(host.state, 'workspace'), { recursive: true });
  assert.equal(host.recoveryInfo(id).info.state, 'paused');
  assert.equal(recoveryAction({ ...modelFailure, recovery: host.recoveryInfo(id).info }), null);
});

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

test('operators cancel, pause, dismiss and retry inspection with idempotent before/after receipts', async t => {
  const { host, id, j, receipt } = hostFixture(t);
  const file = path.join(host.state, 'agent-runs', id + '.json');
  // pause: an active run stops at its checkpoint and is held from automatic recovery
  save(file, { ...receipt, status: 'running' });
  let stopped;
  host.runs.set(id, { write: true, repo: 'demo', stop: reason => { stopped = reason; save(file, { ...receipt, status: 'interrupted' }); } });
  const paused = await host.controlRun({ run_id: id, request_id: 'pause-0001', action: 'pause', reason: 'wrong branch' });
  assert.equal(stopped, 'Paused by operator');
  assert.deepEqual([paused.before.status, paused.after.status], ['running', 'interrupted']);
  assert.deepEqual(await host.controlRun({ run_id: id, request_id: 'pause-0001', action: 'pause', reason: 'wrong branch' }), paused);
  await assert.rejects(host.controlRun({ run_id: id, request_id: 'pause-0001', action: 'cancel' }), /identity conflict/);
  host.runs.delete(id);
  const info = host.recoveryInfo(id).info;
  assert.equal(info.state, 'ready'); assert.match(info.reason, /Paused by operator.*wrong branch/);
  let starts = 0; host.executeRun = async () => { starts++; };
  await host.recoverPending(); assert.equal(starts, 0, 'a held run is not resumed automatically');
  // dismiss: a stopped run gives up recovery without deleting anything and refuses resume
  await assert.rejects(host.controlRun({ run_id: id, request_id: 'cancel-0001', action: 'cancel' }), /not active/);
  const dismissed = await host.controlRun({ run_id: id, request_id: 'dismiss-0001', action: 'dismiss', reason: 'redone by r-x' });
  assert.equal(dismissed.after.recovery.state, 'dismissed');
  assert.equal(read(file).recovery.state, 'dismissed');
  assert.ok(fs.existsSync(path.join(host.state, 'workspace')), 'workspace kept');
  await assert.rejects(host.resumeRun({ run_id: id, request_id: 'after-dismiss', checkpoint_version: j.value.version }), /Dismissed by operator/);
  await assert.rejects(host.controlRun({ run_id: id, request_id: 'dismiss-0002', action: 'dismiss' }), /already dismissed/);
  for (const reason of ['bad\nline', "it's", 'x'.repeat(121)])
    await assert.rejects(host.controlRun({ run_id: id, request_id: 'reason-0001', action: 'dismiss', reason }), /Invalid run action/);
});

test('retry_inspection clears a failed inspection and only applies to one', async t => {
  const { host, id, dir } = hostFixture(t, { uncertain: true });
  save(path.join(dir, 'lifecycle.json'), { inspection_started: 'x', inspection_error: 'Read-only inspection unavailable; operator inspection required' });
  let inspected;
  host.inspectRecovery = async (_r, value) => { inspected = value.lifecycle; };
  await host.controlRun({ run_id: id, request_id: 'inspect-0001', action: 'retry_inspection' });
  assert.deepEqual(inspected, {}); assert.deepEqual(read(path.join(dir, 'lifecycle.json')), {});
  save(path.join(dir, 'lifecycle.json'), { inspection: 'Saved files look complete' });
  await assert.rejects(host.controlRun({ run_id: id, request_id: 'inspect-0002', action: 'retry_inspection' }), /No failed recovery inspection/);
});
