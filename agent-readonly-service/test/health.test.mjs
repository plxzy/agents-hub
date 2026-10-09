import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, defaultFetch } from '../src/worker-core.mjs';

const now = () => new Date().toISOString();
const rpc = (name) => new Request('https://fixture.invalid/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1,
  method: 'tools/call', params: { name, arguments: {} } }) });
function fixture({ snapshot = true, enabled = true, generated_at = now() } = {}) {
  const reads = [], calls = [];
  const stamp = now();
  const env = { RELAY_TOKEN: 'fixture-only',
    DB: { prepare(sql) { reads.push(sql); assert.match(sql, /^SELECT /); return { first: async () => snapshot ? {
      id: 'fixture-snapshot', published_at: stamp, payload: JSON.stringify({ generated_at, capabilities: { run: false, mutate: false }, agents: [{ name: 'helper' }], runs: [], pending: null }) } : null }; } },
    RELAY: { getByName() { return {
      status() { calls.push('status'); return { online: true, enabled, agents: ['helper'], observed_at: stamp, last_seen_at: stamp, protocol_version: 1 }; },
      dispatch() { assert.fail('health must not dispatch, start a model, or issue confirmation codes'); },
    }; } },
  };
  Object.defineProperty(env, 'PUBLISH_TOKEN', { get() { assert.fail('health must not access publisher'); } });
  return { env, reads, calls };
}

for (const name of ['get_status', 'open_dashboard']) for (const enabled of [true, false]) test(`${name} normal health path is read-only and connected/${enabled ? 'enabled' : 'off'}`, async () => {
  const f = fixture({ enabled }); const response = await apiFetch(rpc(name), f.env);
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.result.isError, undefined);
  const value = body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
  assert.equal(value.capabilities.run, false); assert.equal(value.relay.online, true);
  assert.equal(value.relay.enabled, enabled); assert.equal(value.health.execution.enabled, enabled);
  assert.equal(value.health.exit_code, 0); assert.equal(value.health.snapshot.state, 'fresh');
  assert.equal(value.health.last_successful_relay_run, null); assert.match(value.health.history_limitation, /origin/);
  assert.deepEqual(f.calls, ['status']); assert.equal(f.reads.length, 1);
  assert.doesNotMatch(JSON.stringify(value), /fixture-only/);
});

test('health remains readable without a snapshot; old count fields are unknown, not zero', async () => {
  const f = fixture({ snapshot: false });
  const body = await (await apiFetch(rpc('open_dashboard'), f.env)).json();
  const d = body.result.structuredContent;
  assert.equal(d.status.agents, null); assert.equal(d.status.running, null); assert.equal(d.status.pending, null);
  assert.equal(d.health.snapshot.state, 'unavailable'); assert.equal(d.health.snapshot.age_ms, null);
  assert.equal(d.health.relay.state, 'connected'); assert.equal(d.capabilities.run, false);
  assert.deepEqual(d.agents, []); assert.match(body.result.content[0].text, /unknown agents/);
  const counts = await (await apiFetch(rpc('get_status'), f.env)).json();
  assert.equal(JSON.parse(counts.result.content[0].text).agents, null);
});

test('status failure is unknown, not a false fresh offline/off-switch observation', async () => {
  const f = fixture(); f.env.RELAY.getByName = () => ({ status() { throw new Error('fixture failure'); } });
  const body = await (await apiFetch(rpc('get_status'), f.env)).json(); const d = JSON.parse(body.result.content[0].text);
  // Old clients retain fail-closed booleans. New clients use additive availability and health fields.
  assert.equal(d.relay.online, false); assert.equal(d.relay.available, false);
  assert.equal(d.health.relay.state, 'unknown'); assert.equal(d.health.execution.enabled, null);
  assert.equal(d.health.allowlist.observed, null); assert.equal(d.health.exit_code, 2);
});

test('Worker future or malformed snapshot time is stale for old clients and unknown for health', async () => {
  for (const generated_at of ['malformed', new Date(Date.now() + 60000).toISOString()]) {
    const f = fixture({ generated_at }); const body = await (await apiFetch(rpc('get_status'), f.env)).json();
    const d = JSON.parse(body.result.content[0].text);
    assert.equal(d.snapshot.stale, true); assert.equal(d.health.snapshot.state, 'unknown'); assert.equal(d.health.snapshot.age_ms, null);
  }
});

test('public health remains liveness-only; no new private metadata or source access', async () => {
  const env = new Proxy({}, { get() { assert.fail('public health must not access private state'); } });
  const response = await defaultFetch(new Request('https://fixture.invalid/health'), env);
  assert.deepEqual(await response.json(), { ok: true, service: 'agents-hub', capabilities: { discovery: true, status: true, context: true, run: false, mutate: false } });
});
