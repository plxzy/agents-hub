import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serveSocket } from './link-socket.mjs';
import { WIRE, PONG, PING } from './relay-wire.mjs';
const config = { endpoint: 'https://example.test', token: 'not-a-real-token', agents: ['helper'], enabled: true };
const pause = (n) => new Promise((r) => setTimeout(r, n));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(10); } throw new Error('test condition timed out'); }
function fake(onConnect = () => {}) {
  const instances = [];
  class Socket extends EventEmitter {
    constructor(url, options) {
      super(); this.url = url; this.options = options; this.readyState = 1; this.sent = [];
      this.hello = JSON.parse(options.headers['x-relay-hello']); this.socket = 'socket-' + (instances.length + 1);
      instances.push(this); queueMicrotask(() => onConnect(this));
    }
    greet() { this.message({ type: 'hello' }); }
    message(m) { this.emit('message', Buffer.from(JSON.stringify({ v: 1, session: this.hello.session, socket: this.socket, ...m })), false); }
    send(raw) {
      if (raw === PING) { queueMicrotask(() => this.emit('message', Buffer.from(PONG), false)); return; }
      this.sent.push(JSON.parse(raw));
    }
    terminate() { this.readyState = 3; }
  }
  return { Socket, instances };
}
test('foreground socket config, serial commands, expiry, status refresh and abort', async () => {
  const f = fake((ws) => ws.greet()), controller = new AbortController();
  let state = { ...config }, release, calls = 0, snapshots = 0;
  const blocked = new Promise((r) => { release = r; });
  const running = serveSocket({ Socket: f.Socket, signal: controller.signal, readConfig: () => state, log: () => {}, publish: async () => { snapshots++; },
    execute: async () => { calls++; await blocked; return { ok: true, value: { run_id: 'r-test' } }; } });
  await until(() => f.instances.length); const ws = f.instances[0];
  await pause(10);
  assert.equal(ws.options.handshakeTimeout, 10000); assert.equal(ws.options.maxPayload, 262144);
  assert.equal(ws.options.followRedirects, false); assert.equal(ws.options.perMessageDeflate, false);
  assert.equal(ws.url.protocol, 'wss:'); assert.equal(ws.hello.mode, 'acquire');
  ws.message({ type: 'request', id: 'request-one', attempt: 'attempt-one', operation: 'start_run', args: {}, expires: Date.now() + 20000 });
  ws.message({ type: 'request', id: 'request-two', attempt: 'attempt-two', operation: 'start_run', args: {}, expires: Date.now() + 20 });
  await pause(30); assert.equal(calls, 1); release();
  await until(() => ws.sent.filter((m) => m.type === 'result').length === 2);
  assert.equal(calls, 1); assert.equal(ws.sent.find((m) => m.id === 'request-two').result.kind, 'rejected');
  state = { ...state, enabled: false };
  await until(() => ws.sent.some((m) => m.type === 'status' && !m.status.enabled));
  controller.abort(); await running; assert.equal(ws.readyState, 3); assert.equal(snapshots, 1);
});
test('lost replacement close causes resume, never reacquisition; ownership rejection stops', async () => {
  const f = fake((ws) => {
    if (f.instances.length === 1) { ws.greet(); setTimeout(() => ws.emit('close', 1006), 10); }
    else ws.emit('unexpected-response', {}, { statusCode: 409, resume() {} });
  });
  await assert.rejects(serveSocket({ Socket: f.Socket, readConfig: () => config, execute: async () => {}, publish: async () => {}, log: () => {} }), /409/);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[0].hello.mode, 'acquire'); assert.equal(f.instances[1].hello.mode, 'resume');
  assert.equal(f.instances[0].hello.session, f.instances[1].hello.session);
});
test('redirects fail closed, without following them or logging credentials', async () => {
  const f = fake((ws) => ws.emit('unexpected-response', {}, { statusCode: 302, resume() {} }));
  await assert.rejects(serveSocket({ Socket: f.Socket, readConfig: () => config, execute: async () => {}, publish: async () => {}, log: () => {} }), /HTTP 302/);
  assert.equal(f.instances.length, 1);
});
test('complete multibyte server messages exceed byte limit and stop the session', async () => {
  const f = fake((ws) => { ws.greet(); ws.message({ type: 'request', text: '😀'.repeat(WIRE.messageBytes / 3) }); });
  await assert.rejects(serveSocket({ Socket: f.Socket, readConfig: () => config, execute: async () => { throw new Error('must not run'); }, publish: async () => {}, log: () => {} }), /protocol/);
});
test('hello timeout closes the socket and retries only with resume', async () => {
  const f = fake((ws) => { if (f.instances.length > 1) ws.emit('unexpected-response', {}, { statusCode: 409, resume() {} }); });
  const start = Date.now();
  await assert.rejects(serveSocket({ Socket: f.Socket, readConfig: () => config, execute: async () => {}, publish: async () => {}, log: () => {} }), /409/);
  assert.ok(Date.now() - start >= WIRE.handshake);
  assert.equal(f.instances[0].readyState, 3); assert.equal(f.instances[1].hello.mode, 'resume');
});

test('relay health reports authenticated pong freshness and disconnects as unhealthy', async () => {
  const f = fake((ws) => ws.greet()), controller = new AbortController(), states = [];
  const running = serveSocket({ Socket: f.Socket, signal: controller.signal, readConfig: () => config,
    execute: async () => {}, publish: async () => {}, log: () => {}, onState: state => states.push(state) });
  await until(() => states.some(state => state.last_pong_at));
  assert.equal(states[0].hub_ready, false);
  assert.ok(states.some(state => state.hub_ready === true && state.last_pong_at === null));
  assert.ok(states.some(state => state.hub_ready === true && typeof state.last_pong_at === 'string'));
  controller.abort(); await running;
  assert.equal(states.at(-1).hub_ready, false);
  assert.equal(states.at(-1).last_pong_at, null);
});
