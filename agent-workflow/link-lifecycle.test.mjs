import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serveSocket } from './link-socket.mjs';
import { WIRE, PING, PONG } from './relay-wire.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { executeJob } from './link.mjs';

const config = { endpoint: 'https://fixture.invalid', token: 'disposable-fixture-token', agents: ['helper'], enabled: true };
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
function fixture(t, onConnect, execute = async () => ({ ok: true, value: 'fixture' })) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  t.mock.method(Math, 'random', () => 1);
  const instances = [], controller = new AbortController();
  let state = { ...config }, executions = 0;
  class Socket extends EventEmitter {
    constructor(url, options) {
      super(); this.url = url; this.options = options; this.hello = JSON.parse(options.headers['x-relay-hello']);
      this.socket = 'socket-' + (instances.length + 1); this.readyState = 1; this.sent = []; this.pongs = true;
      instances.push(this); queueMicrotask(() => onConnect(this, instances.length));
    }
    message(m) { this.emit('message', Buffer.from(JSON.stringify({ v: 1, session: this.hello.session, socket: this.socket, ...m })), false); }
    greet() { this.message({ type: 'hello' }); }
    send(raw) { this.sent.push(raw === PING ? raw : JSON.parse(raw)); if (raw === PING && this.pongs) queueMicrotask(() => this.emit('message', Buffer.from(PONG), false)); }
    terminate() { this.readyState = 3; }
    refuse(code) { this.emit('unexpected-response', {}, { statusCode: code, resume() {} }); }
  }
  const running = serveSocket({ Socket, signal: controller.signal, readConfig: () => state,
    execute: async (...args) => { executions++; return execute(...args); }, publish: async () => {}, log: () => {} });
  // Attach immediately, including when the test expects a fatal rejection.
  running.catch(() => {});
  t.after(async () => { controller.abort(); await running.catch(() => {}); });
  return { instances, controller, running, setConfig: c => { state = c; }, calls: () => executions,
    advance: async ms => { t.mock.timers.tick(ms); await flush(); } };
}

test('network drop resumes with current config and never automatically redispatches work', async t => {
  const f = fixture(t, ws => ws.greet()); await flush(); const first = f.instances[0];
  first.message({ type: 'request', id: 'request-one', attempt: 'attempt-one', operation: 'panel_data', args: {}, expires: Date.now() + WIRE.attempt });
  await flush(); assert.equal(f.calls(), 1); // result deliberately unacknowledged
  first.emit('close', 1006); await flush();
  f.setConfig({ ...config, enabled: false });
  await f.advance(1000); const second = f.instances[1];
  assert.equal(first.readyState, 3); assert.equal(second.hello.mode, 'resume');
  assert.equal(second.hello.session, first.hello.session); assert.equal(second.hello.status.enabled, false);
  await f.advance(10000);
  assert.equal(f.calls(), 1); assert.deepEqual(second.sent.filter(m => m.type === 'result'), []);
});

test('transient handshake failures back off to a cap, retain ownership and cancel promptly', async t => {
  const f = fixture(t, (ws, n) => n % 2 ? ws.emit('error', new Error('fixture network failure')) : ws.refuse(503));
  await flush();
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    const count = f.instances.length;
    await f.advance(delay - 1); assert.equal(f.instances.length, count);
    await f.advance(1); assert.equal(f.instances.length, count + 1);
  }
  assert.equal(f.instances[0].hello.mode, 'acquire');
  assert.ok(f.instances.slice(1).every(ws => ws.hello.mode === 'resume' && ws.hello.session === f.instances[0].hello.session));
  f.controller.abort(); await f.running;
  await f.advance(60000); assert.equal(f.instances.length, 7);
  assert.ok(f.instances.every(ws => ws.readyState === 3));
});

test('a transient failed handshake can recover without reacquisition', async t => {
  const f = fixture(t, (ws, n) => n === 1 ? ws.refuse(503) : ws.greet()); await flush();
  await f.advance(2000); assert.equal(f.instances.length, 2);
  assert.equal(f.instances[1].hello.mode, 'resume'); assert.ok(f.instances[1].sent.includes(PING));
});

for (const code of [400, 401, 403, 404, 409, 426]) test(`fatal handshake HTTP ${code} requires manual restart`, async t => {
  const f = fixture(t, ws => ws.refuse(code));
  await assert.rejects(f.running, new RegExp('HTTP ' + code));
  await f.advance(60000); assert.equal(f.instances.length, 1); assert.equal(f.instances[0].readyState, 3);
});

test('simulated suspend invalidates stale liveness and restores authenticated current configuration', async t => {
  const f = fixture(t, ws => ws.greet()); await flush(); const old = f.instances[0];
  f.setConfig({ ...config, token: 'updated-disposable-fixture-token', enabled: false });
  old.pongs = false;
  // Move wall time without executing timers: a suspend, not a series of ordinary idle ticks.
  t.mock.timers.setTime(Date.now() + WIRE.freshness + 1000);
  await f.advance(1000); assert.equal(old.readyState, 3);
  await f.advance(1000); const resumed = f.instances[1];
  assert.equal(resumed.hello.mode, 'resume'); assert.equal(resumed.hello.session, old.hello.session);
  assert.equal(resumed.options.headers.authorization, 'Bearer updated-disposable-fixture-token');
  assert.deepEqual(resumed.hello.status, { enabled: false, agents: ['helper'] }); assert.ok(resumed.sent.includes(PING));
});

test('unanswered keepalives expire liveness even while the socket appears open', async t => {
  const f = fixture(t, ws => ws.greet()); await flush(); const old = f.instances[0]; old.pongs = false;
  for (let i = 0; i < WIRE.freshness / 1000; i++) await f.advance(1000);
  assert.equal(old.readyState, 3); await f.advance(1000); assert.equal(f.instances.length, 2);
});

test('an unauthenticated/unidentified socket cannot execute a command', async t => {
  const f = fixture(t, ws => ws.message({ type: 'request', id: 'request-one', attempt: 'attempt-one', operation: 'panel_data', args: {}, expires: Date.now() + WIRE.attempt }));
  await assert.rejects(f.running, /protocol/); assert.equal(f.calls(), 0);
});

test('disconnect cancels unstarted queued requests, not an already executing command', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, ws => ws.greet(), async () => { await blocked; return { ok: true, value: 'done' }; });
  t.after(() => release()); await flush(); const old = f.instances[0];
  for (const suffix of ['one', 'two']) old.message({ type: 'request', id: 'request-' + suffix, attempt: 'attempt-' + suffix,
    operation: 'panel_data', args: {}, expires: Date.now() + WIRE.attempt });
  await flush(); assert.equal(f.calls(), 1); old.emit('close', 1006); await flush();
  await f.advance(1000); release(); await flush();
  assert.equal(f.calls(), 1); assert.deepEqual(f.instances[1].sent.filter(m => m.type === 'result'), []);
});

test('a lost result is recovered only by explicit same-ID retry through the mutation journal', async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.plan-1b-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents/helper.md'), `---\nname: helper\ntools: read\nworkspace: ${root}\n---\nFixture\n`);
  let mutations = 0;
  const f = fixture(t, ws => ws.greet(), async (job, config) => ({ ok: true, value: await executeJob(job, {
    config, ctx: { root, state: path.join(root, 'state') }, journal: path.join(root, 'journal'),
    execute: async () => { mutations++; return { run_id: 'r-fixture' }; },
  }) }));
  await flush(); const request = { type: 'request', id: 'journal-request', attempt: 'attempt-original', operation: 'start_run',
    args: { agent: 'helper', task: 'fixture', request_id: 'journal-request' }, expires: Date.now() + WIRE.attempt };
  f.instances[0].message(request); await flush(); assert.equal(mutations, 1);
  f.instances[0].emit('close', 1006); await flush(); await f.advance(1000);
  const resumed = f.instances[1]; assert.deepEqual(resumed.sent.filter(m => m.type === 'result'), []);
  resumed.message({ ...request, attempt: 'attempt-retry', expires: Date.now() + WIRE.attempt }); await flush();
  assert.equal(mutations, 1); assert.equal(f.calls(), 2);
  assert.deepEqual(resumed.sent.find(m => m.type === 'result').result, { ok: true, value: { run_id: 'r-fixture' } });
});
