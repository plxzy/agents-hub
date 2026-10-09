import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { requestRelay, relayFetch, relayStatus } from '../src/relay.mjs';
// Cloudflare extension absent in Node's WebCrypto.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(new URL('../migrations/0002_relay.sql', import.meta.url), 'utf8'));
  return { RELAY_TOKEN: 'test-token', DB: { prepare(sql) {
    const stmt = db.prepare(sql);
    const bound = (...args) => ({ run: async () => stmt.run(...args), first: async () => stmt.get(...args) ?? null });
    return { bind: bound, ...bound() };
  } } };
}
function rpc(route, body, token = 'test-token') {
  return new Request('https://example.test/relay/' + route, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
}
test('relay credential is required and offline work is never queued', async (t) => {
  const env = fixture(t);
  assert.equal((await relayFetch(rpc('poll', {}, 'wrong'), env)).status, 401);
  await assert.rejects(requestRelay(env, 'panel_data', {}), /offline/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM relay_jobs').first()).n, 0);
});
test('atomic claims are not redelivered; result replay rejects request-id conflicts', async (t) => {
  const env = fixture(t); const state = { enabled: true, agents: ['helper'] };
  await relayFetch(rpc('poll', state), env);
  let claims = 0;
  const args = { agent: 'helper', task: 'read', request_id: 'request-123' };
  const wait = async () => {
    const { job } = await (await relayFetch(rpc('poll', state), env)).json();
    if (job) {
      claims++;
      assert.equal((await (await relayFetch(rpc('poll', state), env)).json()).job, null);
      await relayFetch(rpc('complete', { id: job.id, result: { ok: true, value: { run_id: 'r-test' } } }), env);
    }
  };
  assert.deepEqual(await requestRelay(env, 'start_run', args, { wait }), { run_id: 'r-test' });
  assert.deepEqual(await requestRelay(env, 'start_run', args, { wait }), { run_id: 'r-test' });
  assert.equal(claims, 1);
  await assert.rejects(requestRelay(env, 'start_run', { ...args, task: 'different' }, { wait }), /different action/);
  const row = await env.DB.prepare('SELECT * FROM relay_jobs').first(); assert.equal(row.args, null);
});
test('off switch and allowlist fail closed; unclaimed timed-out work is removed', async (t) => {
  const env = fixture(t); await relayFetch(rpc('poll', { enabled: false, agents: ['helper'] }), env);
  assert.equal((await relayStatus(env)).enabled, false);
  await assert.rejects(requestRelay(env, 'start_run', { agent: 'helper', task: 'read', request_id: 'request-123' }), /off/);
  await assert.rejects(requestRelay(env, 'panel_data', {}, { wait: async () => {} }), /response unavailable/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM relay_jobs').first()).n, 0);
});
