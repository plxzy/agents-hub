import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callOp, OPS } from './ops.mjs';
import { createServer } from './mcp.mjs';
import { validateSelectedStart, dokTarget } from './run-selection.mjs';
import { DevelopmentSessions } from './dev-sessions.mjs';
const args = { runner: 'dok', agent: 'demo', task: 'Read the README', request_id: 'request-test-01' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selected-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents/demo.md'), `---\nname: demo\nworkspace: ${root}\ntools: read\n---\nRead only.\n`);
  return { root, state: path.join(root, 'state'), hub: { endpoint: 'https://example.test', token: 'test-only' },
    spawn() { assert.fail('dok must never spawn locally'); } };
}
test('explicit selection strictly validates runner and fields; old operations reject new tool', async t => {
  for (const runner of [undefined, null, '', 'local', 'cloudflare']) assert.throws(() => validateSelectedStart({ ...args, runner }));
  for (const extra of [{ model: 'openai/anything' }, { repo: 'other' }, { cwd: '/tmp' }, { continue: false }]) assert.throws(() => validateSelectedStart({ ...args, ...extra }));
  const ctx = fixture(t), old = createServer({ ctx, ops: OPS.filter(o => !['start_selected_run', 'get_selected_start'].includes(o.name)) });
  const r = await old({ id: 1, method: 'tools/call', params: { name: 'start_selected_run', arguments: args } });
  assert.match(r.error.message, /unknown tool/);
});
test('simultaneous same-id starts dispatch once; changed payload is refused', async t => {
  const ctx = fixture(t); let release, posts = 0;
  ctx.fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return Response.json({ state: 'pending' });
    posts++; assert.equal(init.signal instanceof AbortSignal, true);
    return new Promise(resolve => { release = () => resolve(Response.json({ run_id: 'r-20261013T000000Z-abcdef', status: 'running' })); });
  };
  const a = callOp('start_selected_run', args, { ctx });
  const b = await callOp('start_selected_run', args, { ctx });
  assert.equal(b.state, 'unknown'); assert.equal(posts, 1);
  release(); assert.equal((await a).state, 'started');
  await assert.rejects(callOp('start_selected_run', { ...args, task: 'different' }, { ctx }), /different task/);
  assert.equal((await callOp('start_selected_run', args, { ctx })).state, 'started'); assert.equal(posts, 1);
});
test('lost response survives reopening and reconciles by GET without another dispatch', async t => {
  const ctx = fixture(t); let posts = 0, found = false;
  ctx.fetchImpl = async (url, init) => {
    if (init.method === 'POST') { posts++; throw new Error('response lost'); }
    if (url.endsWith('/panel')) throw new Error('offline');
    return Response.json(found ? { state: 'started', run_id: 'r-20261013T000000Z-abcdef', status: 'completed' } : { state: 'not_found' });
  };
  assert.equal((await callOp('start_selected_run', args, { ctx })).state, 'unknown');
  const reopened = await callOp('open_dashboard', {}, { ctx: { ...ctx } });
  assert.equal(reopened.start_requests[0].request_id, args.request_id);
  assert.equal((await callOp('get_selected_start', { request_id: args.request_id }, { ctx })).state, 'unknown', 'absence is not safe retry authorization');
  // A fresh UI UUID for the identical unresolved task must also reconcile the original.
  assert.equal((await callOp('start_selected_run', { ...args, request_id: 'request-other-id' }, { ctx })).request_id, args.request_id);
  found = true;
  const status = await callOp('get_selected_start', { request_id: args.request_id }, { ctx });
  assert.equal(status.state, 'started'); assert.equal(status.status, 'completed'); assert.equal(posts, 1);
});
test('missing endpoint/authentication failures never fall back to Mac', async t => {
  for (const status of [401, 403, 404, 409, 500]) {
    const ctx = fixture(t); ctx.fetchImpl = async () => Response.json({ error: 'refused' }, { status });
    assert.equal((await callOp('start_selected_run', args, { ctx })).state, status === 500 ? 'unknown' : 'not_started');
  }
});
test('Mac starts and local discovery work without a remote request', async t => {
  const ctx = fixture(t); let spawns = 0;
  ctx.fetchImpl = async () => { throw new Error('Hub unavailable'); };
  ctx.spawn = () => { spawns++; return { pid: process.pid, unref() {} }; };
  const dash = await callOp('open_dashboard', {}, { ctx });
  assert.equal(dash.run_targets[0].available, false); assert.equal(dash.run_targets[1].agents[0].name, 'demo');
  ctx.fetchImpl = () => assert.fail('explicit Mac start must not contact Hub');
  const a = { ...args, runner: 'mac' };
  assert.equal((await callOp('start_selected_run', a, { ctx })).state, 'started');
  assert.equal((await callOp('start_selected_run', a, { ctx })).state, 'started'); assert.equal(spawns, 1);
});
test('runner observations distinguish missing protocol, disabled and offline', () => {
  assert.match(dokTarget({ online: true, enabled: true, agents: [] }).reason, /update/);
  assert.match(dokTarget({ online: true, enabled: false, agents: [] }).reason, /disabled/);
  assert.match(dokTarget({ online: false }).reason, /offline/);
});
test('dok journal lookup survives process reconstruction and drops private receipt fields', t => {
  const { state } = fixture(t);
  fs.mkdirSync(path.join(state, 'agent-requests'), { recursive: true });
  fs.mkdirSync(path.join(state, 'agent-runs'));
  const id = 'mac-request-test-01', run_id = 'r-20261013T000000Z-abcdef';
  fs.writeFileSync(path.join(state, 'agent-requests', id + '.json'), JSON.stringify({ fingerprint: 'example', run_id }));
  fs.writeFileSync(path.join(state, 'agent-runs', run_id + '.json'), JSON.stringify({ run_id, status: 'completed', root: '/private', task: 'private task' }));
  const host = Object.assign(Object.create(DevelopmentSessions.prototype), { state });
  assert.deepEqual(host.runLookup(id), { state: 'started', run_id, status: 'completed', runner: 'dok' });
  assert.deepEqual(host.runLookup('mac-request-not-found'), { state: 'not_found' });
});
