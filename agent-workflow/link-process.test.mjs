import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
const fixture = new URL('./fixtures/plan-1b-relay.mjs', import.meta.url);

function child(t, ...args) {
  const process = fork(fixture, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [], waiters = []; let stderr = '';
  process.stderr.on('data', data => { stderr += data; });
  const exited = once(process, 'exit');
  process.on('message', m => {
    messages.push(m);
    for (const w of [...waiters]) if (w.event === m.event) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m); }
  });
  t.after(async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await exited; });
  const next = event => {
    const old = messages.find(m => m.event === event);
    if (old) { messages.splice(messages.indexOf(old), 1); return Promise.resolve(old); }
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve: m => { messages.splice(messages.indexOf(m), 1); resolve(m); } };
      waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Fixture timeout: ' + event + '\n' + stderr)); }, 15000);
      waiters.push(waiter);
    });
  };
  return { process, next, exited };
}
function config(t, port) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.plan-1b-process-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'link.json'), JSON.stringify({ endpoint: 'https://127.0.0.1:' + port,
    token: 'disposable-plan-1b-token-not-a-secret', enabled: true, agents: ['helper'] }));
  return dir;
}

test('disposable foreground relay: network recovery, Ctrl-C, crash, single owner and manual restart', { timeout: 30000 }, async t => {
  const server = child(t, 'server', '0'), { port } = await server.next('listening'), dir = config(t, port);
  const first = child(t, 'client', dir), acquired = await server.next('connected');
  assert.equal(acquired.mode, 'acquire'); await server.next('pong');
  const second = child(t, 'client', dir);
  assert.match((await second.next('refused')).error, /running|acquisition/); assert.deepEqual(await second.exited, [1, null]);
  assert.equal(fs.readFileSync(path.join(dir, 'link.lock'), 'utf8'), String(first.process.pid));
  server.process.send('drop'); await server.next('closed');
  const resumed = await server.next('connected');
  assert.equal(resumed.mode, 'resume'); assert.equal(resumed.session, acquired.session);
  first.process.kill('SIGINT'); const stopped = await first.next('stopped');
  assert.equal(stopped.signalsRestored, true); assert.equal(stopped.lockExists, false); assert.deepEqual(await first.exited, [0, null]);
  assert.equal(fs.existsSync(path.join(dir, 'link.lock.acquiring')), false);
  const restarted = child(t, 'client', dir), fresh = await server.next('connected');
  assert.equal(fresh.mode, 'acquire'); assert.notEqual(fresh.session, acquired.session);
  restarted.process.kill('SIGKILL'); assert.deepEqual(await restarted.exited, [null, 'SIGKILL']);
  assert.equal(fs.readFileSync(path.join(dir, 'link.lock'), 'utf8'), String(restarted.process.pid));
  const manual = child(t, 'client', dir), manualHello = await server.next('connected');
  assert.equal(manualHello.mode, 'acquire'); assert.notEqual(manualHello.session, fresh.session);
  manual.process.kill('SIGTERM'); assert.equal((await manual.next('stopped')).lockExists, false); assert.deepEqual(await manual.exited, [0, null]);
});

test('abrupt disposable server termination and explicit server restart preserve the client session', { timeout: 30000 }, async t => {
  const server = child(t, 'server', '0'), { port } = await server.next('listening'), dir = config(t, port);
  const client = child(t, 'client', dir), original = await server.next('connected'); await server.next('pong');
  server.process.kill('SIGKILL'); assert.deepEqual(await server.exited, [null, 'SIGKILL']);
  // Restore only fixture ownership, modelling the durable owner record; no real hosted state is touched.
  const manual = child(t, 'server', String(port), original.session); await manual.next('listening');
  const recovered = await manual.next('connected'); assert.equal(recovered.mode, 'resume'); assert.equal(recovered.session, original.session);
  await manual.next('pong'); client.process.kill('SIGINT'); assert.equal((await client.next('stopped')).lockExists, false);
  assert.deepEqual(await client.exited, [0, null]);
});

test('simultaneous manual restarts reclaim a dead owner with only one live winner', { timeout: 30000 }, async t => {
  const server = child(t, 'server', '0'), { port } = await server.next('listening'), dir = config(t, port);
  const old = child(t, 'client', dir); await server.next('connected');
  old.process.kill('SIGKILL'); await old.exited;
  const left = child(t, 'client', dir), right = child(t, 'client', dir);
  await server.next('connected');
  const pid = Number(fs.readFileSync(path.join(dir, 'link.lock'), 'utf8'));
  assert.ok([left.process.pid, right.process.pid].includes(pid));
  const [winner, loser] = pid === left.process.pid ? [left, right] : [right, left];
  assert.match((await loser.next('refused')).error, /running|acquisition/); assert.deepEqual(await loser.exited, [1, null]);
  assert.equal(fs.readFileSync(path.join(dir, 'link.lock'), 'utf8'), String(winner.process.pid));
  winner.process.kill('SIGINT'); assert.equal((await winner.next('stopped')).lockExists, false); await winner.exited;
});
