import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeJob } from './link.mjs';
import { relayToolList } from './relay-contract.mjs';
import { remoteSandbox, sandboxProfile } from './agent.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'agents'));
  for (const name of ['helper', 'workflow']) fs.writeFileSync(path.join(root, 'agents', name + '.md'), `---\nname: ${name}\nworkspace: ${root}\n---\nTest\n`);
  return { ctx: { root, state: path.join(root, 'state') }, journal: path.join(root, 'journal'), config: { enabled: true, agents: ['helper'] } };
}
const job = (id = 'request-123') => ({ id, operation: 'start_run', args: { agent: 'helper', task: 'read only', request_id: id }, expires: Date.now() + 20000 });
test('Mac enforces allowlist, off switch, deadline and schema before execution', async (t) => {
  const f = fixture(t); let calls = 0; f.execute = async () => { calls++; return { run_id: 'r-test' }; };
  await assert.rejects(executeJob({ ...job(), args: { ...job().args, agent: 'workflow' } }, f), /not allowed/);
  await assert.rejects(executeJob(job(), { ...f, config: { ...f.config, enabled: false } }), /disabled/);
  await assert.rejects(executeJob({ ...job(), expires: 0 }, f), /Expired/);
  await assert.rejects(executeJob({ ...job(), args: { ...job().args, cwd: '/tmp' } }, f), /Invalid cwd/);
  await assert.rejects(executeJob({ ...job(), operation: 'run_eval' }, f), /Invalid relay/);
  assert.equal(calls, 0);
});
test('completed requests replay, conflicts fail and interrupted mutations never rerun', async (t) => {
  const f = fixture(t); let calls = 0;
  f.execute = async () => { calls++; return { run_id: 'r-test' }; };
  assert.deepEqual(await executeJob(job(), f), { run_id: 'r-test' });
  assert.deepEqual(await executeJob(job(), f), { run_id: 'r-test' });
  assert.equal(calls, 1);
  await assert.rejects(executeJob({ ...job(), args: { ...job().args, task: 'different' } }, f), /conflict/);
  f.execute = async () => { calls++; throw new Error('crash'); };
  await assert.rejects(executeJob(job('request-fail'), f), /crash/);
  await assert.rejects(executeJob(job('request-fail'), f), /will not be executed again/);
  assert.equal(calls, 2);
});
test('model results are limited to relay-started runs; decision tools are app-only', async (t) => {
  const f = fixture(t);
  await assert.rejects(executeJob({ id: 'query-123', operation: 'get_remote_run', args: { run_id: 'r-unknown' }, expires: Date.now() + 10000 }, f), /Not a relay/);
  for (const name of ['rate_run', 'review_decide', 'panel_data', 'panel_run']) assert.deepEqual(relayToolList().find((t) => t.name === name)._meta.ui.visibility, ['app']);
  assert.equal(relayToolList().find((t) => t.name === 'start_run')._meta, undefined);
});
test('remote helpers get the hard credential sandbox even without write_paths', () => {
  const agent = remoteSandbox({ writePaths: null, guard: null }, { AGENT_REMOTE_RUN: '1' });
  assert.deepEqual(agent.writePaths, []);
  assert.equal(agent.guard, 'readonly');
  assert.match(sandboxProfile(agent), /\.config\/agent-readonly/);
});

test('agents with a shell cannot be started remotely, and remote runs load the remote guard', async (t) => {
  const f = fixture(t); let calls = 0; f.execute = async () => { calls++; return { run_id: 'r-x' }; };
  fs.writeFileSync(path.join(f.ctx.root, 'agents', 'helper.md'), `---\nname: helper\ntools: bash, read\nworkspace: ${f.ctx.root}\n---\nTest\n`);
  await assert.rejects(executeJob(job('request-shell'), f), /shell/);
  assert.equal(calls, 0);
  const { piArgs } = await import('./agent.mjs');
  const args = piArgs(remoteSandbox({ name: 'h', tools: ['read'], skills: 'none' }, { AGENT_REMOTE_RUN: '1' }), { task: 't', prompt: 'p', sessionDir: '/tmp/s' });
  assert.ok(args.some((a) => a.endsWith('guards/remote.ts')));
});

test('decisions need a one-time code that only panel_data hands out', async (t) => {
  const f = fixture(t); const { confirmations } = await import('./link.mjs');
  f.execute = async (name) => (name === 'review_decide' ? 'accepted' : 'rated');
  const decide = (id, confirm) => executeJob({ id, operation: 'review_decide', expires: Date.now() + 20000,
    args: { id: 'p-1', decision: 'accept', request_id: id, ...(confirm ? { confirm } : {}) } }, f);
  await assert.rejects(decide('request-noconf'), /Missing confirm/);
  await assert.rejects(decide('request-badconf', 'x'.repeat(24)), /click in the Agents Hub panel/);
  confirmations.set('c'.repeat(24), { kind: 'review', target: 'p-1', expires: Date.now() + 60000 });
  assert.equal(await decide('request-badconf', 'c'.repeat(24)), 'accepted'); // a refused attempt leaves its id usable
  await assert.rejects(decide('request-again', 'c'.repeat(24)), /click in the Agents Hub panel/); // one use only
  confirmations.set('d'.repeat(24), { kind: 'rate', target: 'p-1', expires: Date.now() + 60000 });
  await assert.rejects(decide('request-kind', 'd'.repeat(24)), /click in the Agents Hub panel/); // wrong kind
});

test('canonical receipts ignore property order and transport expiry; semantic conflicts fail', async (t) => {
  const f = fixture(t); let calls = 0; f.execute = async () => { calls++; return { run_id: 'r-canonical' }; };
  const first = job('canonical-123'); await executeJob(first, f);
  const retry = { ...first, expires: Date.now() + 20000, args: { task: first.args.task, request_id: first.id, agent: 'helper' } };
  assert.deepEqual(await executeJob(retry, f), { run_id: 'r-canonical' });
  assert.equal(calls, 1);
  await assert.rejects(executeJob({ ...retry, args: { ...retry.args, task: 'changed' } }, f), /conflict/);
});
test('legacy receipts upgrade only after their original hash matches; claims never rerun', async (t) => {
  const f = fixture(t); const { createHash } = await import('node:crypto');
  const first = job('legacy-123');
  const fingerprint = createHash('sha256').update(first.operation + '\n' + JSON.stringify(first.args)).digest('hex');
  fs.mkdirSync(f.journal, { recursive: true });
  const file = path.join(f.journal, first.id + '.json');
  fs.writeFileSync(file, JSON.stringify({ fingerprint, state: 'done', value: { run_id: 'r-legacy' } }));
  f.execute = () => { throw new Error('must not execute'); };
  const reordered = { ...first, args: { task: first.args.task, agent: 'helper', request_id: first.id } };
  await assert.rejects(executeJob(reordered, f), /legacy receipts/);
  assert.deepEqual(await executeJob(first, f), { run_id: 'r-legacy' });
  assert.deepEqual(await executeJob(reordered, f), { run_id: 'r-legacy' });
  const upgraded = JSON.parse(fs.readFileSync(file)); assert.equal(upgraded.fingerprint, fingerprint); assert.ok(upgraded.fingerprintV2);
  fs.writeFileSync(file, JSON.stringify({ fingerprint, state: 'claimed' }));
  await assert.rejects(executeJob(first, f), /will not be executed again/);
});
test('a completed receipt remains recoverable when remote starts are subsequently disabled', async (t) => {
  const f = fixture(t); f.execute = async () => ({ run_id: 'r-done' });
  await executeJob(job('off-replay'), f);
  assert.deepEqual(await executeJob(job('off-replay'), { ...f, config: { enabled: false, agents: [] } }), { run_id: 'r-done' });
});
