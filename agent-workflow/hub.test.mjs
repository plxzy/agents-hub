import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubConfig, hubReceipt, sendReceipt, flushOutbox, hubMemory, refreshHubCache, cachedPending, hubPanel, hubRun, trackHubRun } from './hub.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
const config = { endpoint: 'https://hub.example', token: 't'.repeat(32) };
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('Mac receipt carries bounded failure evidence without raw state', () => {
  const context = { phase: 'model', last_tool: 'read', provider: 'openai', model: 'gpt-6-luna', message: '503 service unavailable' };
  const r = hubReceipt({ status: 'failed', output: 'Partial answer', output_partial: true, failure_context: context, raw_events: '/private/log', transcript: 'private' });
  assert.deepEqual(r.failure_context, context); assert.equal(r.output_partial, true);
  assert.equal(r.raw_events, undefined); assert.equal(r.transcript, undefined);
});

test('live receipts retry without an outbox and stop drains the heartbeat before final publication', async () => {
  const calls = [], timers = [];
  let finish, count = 0, canceled;
  const stop = await trackHubRun({ run_id: 'r-20261013T000000Z-abcdef', agent: 'helper', started: '2026-10-13T00:00:00Z',
    workspace: '/private', pid: 123 }, { config,
    schedule: fn => { timers.push(fn); return timers.length; }, cancel: id => { canceled = id; },
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      if (++count === 1) throw new Error('offline');
      return new Promise(resolve => { finish = () => resolve(reply(200, {})); });
    } });
  assert.equal(calls[0].status, 'running'); assert.equal(calls[0].workspace, undefined); assert.equal(calls[0].pid, undefined);
  assert.equal(timers.length, 1);
  timers[0]();
  let stopped = false;
  const draining = stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  finish(); await draining;
  assert.equal(stopped, true); assert.equal(canceled, 1); assert.equal(timers.length, 1);
  assert.equal(calls.length, 2);
  const unlinked = await trackHubRun({}, { config: null, fetchImpl: () => assert.fail('unlinked') });
  await unlinked();
});

test('panel and run reads use the Mac routes, bounded requests, and no write body', async () => {
  const panel = { status: { agents: 1 }, agents: [{ name: 'helper' }], runs: [], pending: [] };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error'); assert.ok(init.signal); return reply(200, url.endsWith('/panel') ? panel : { run_id: 'r-1' }); };
  assert.deepEqual(await hubPanel({ config, fetchImpl }), panel);
  assert.deepEqual(await hubRun('r-1', { config, fetchImpl }), { run_id: 'r-1' });
  assert.deepEqual(calls, ['https://hub.example/relay/mac/panel', 'https://hub.example/relay/mac/runs/r-1']);
  await assert.rejects(hubPanel({ config, fetchImpl: async () => reply(200, {}) }), /invalid panel/);
  await assert.rejects(hubPanel({ config, fetchImpl: async () => reply(503, {}) }), /503/);
});

test('config needs https and a real token; AGENT_HUB=0 turns the link off', () => {
  const dir = tmp(), file = path.join(dir, 'mac.json');
  assert.equal(hubConfig(file, {}), null);
  fs.writeFileSync(file, JSON.stringify({ endpoint: 'http://x', token: 't'.repeat(32) })); assert.equal(hubConfig(file, {}), null);
  fs.writeFileSync(file, JSON.stringify({ endpoint: 'https://hub.example/', token: 'short' })); assert.equal(hubConfig(file, {}), null);
  fs.writeFileSync(file, JSON.stringify(config)); assert.deepEqual(hubConfig(file, {}), config);
  assert.equal(hubConfig(file, { AGENT_HUB: '0' }), null);
});

test('only whitelisted receipt fields leave the Mac; commands, paths and transcripts stay', () => {
  const out = hubReceipt({ run_id: 'r-20261012T120000Z-abcdef', agent: 'helper', kind: 'task', status: 'unknown', task: 't', started: 's', output: 'o',
    commands: ['rm x'], workspace: '/Users/x', raw_events: '/x', transcript: 'secret', session_file: '/y', blocked: ['a'], memory_source: 'hub', memory_hash: 'h' },
  [{ scope: 'shared', body: 'note' }]);
  assert.deepEqual(Object.keys(out).sort(), ['agent', 'blocked', 'kind', 'memory_hash', 'memory_proposals', 'memory_proposed', 'memory_source', 'output', 'run_id', 'started', 'status', 'task']);
  assert.equal(out.status, 'interrupted'); assert.equal(out.memory_proposed, 1);
});

test('a receipt that cannot be sent waits in the outbox and goes out later', async () => {
  const state = tmp(), receipt = { run_id: 'r-20261012T120000Z-abcdef', agent: 'helper', status: 'completed', task: 't', started: 's' };
  assert.equal(await sendReceipt(receipt, { state, config, fetchImpl: async () => { throw new Error('offline'); } }), 'queued');
  assert.deepEqual(fs.readdirSync(path.join(state, 'hub-outbox')), [`${receipt.run_id}.json`]);
  const calls = [];
  assert.equal(await flushOutbox({ state, config, fetchImpl: async (url, init) => { calls.push([url, init.method, init.headers.authorization]); return reply(200, { ok: true }); } }), 1);
  assert.deepEqual(calls, [['https://hub.example/relay/mac/runs', 'POST', `Bearer ${config.token}`]]);
  assert.deepEqual(fs.readdirSync(path.join(state, 'hub-outbox')), []);
  assert.equal(await sendReceipt(receipt, { state, config: null }), 'unlinked');
});

test('accepted notes come from the bundle; an unreachable Hub returns null so the caller falls back', async () => {
  const got = await hubMemory(['shared', 'agent:helper'], { config, fetchImpl: async (url) => {
    assert.match(url, /bundle\?scopes=shared%2Cagent%3Ahelper$/);
    return reply(200, { memory: [{ id: 'm-1', scope: 'shared', body: 'x' }], hash: 'abc' }); } });
  assert.deepEqual(got, { items: [{ meta: { id: 'm-1', scope: 'shared', status: 'accepted' }, body: 'x' }], hash: 'abc' });
  assert.equal(await hubMemory(['shared'], { config, fetchImpl: async () => reply(503, {}) }), null);
  assert.equal(await hubMemory(['shared'], { config: null }), null);
});

test('the review queue is cached for synchronous views and marked as Hub-held', async () => {
  const state = tmp();
  assert.deepEqual(cachedPending(state), []);
  assert.equal(await refreshHubCache({ state, config, fetchImpl: async () => reply(200, { pending: [{ id: 'm-1', kind: 'memory', body: 'b' }] }) }), true);
  assert.deepEqual(cachedPending(state), [{ id: 'm-1', kind: 'memory', body: 'b', hub: true }]);
  assert.equal(await refreshHubCache({ state, config, fetchImpl: async () => { throw new Error('x'); } }), false);
  assert.equal(cachedPending(state).length, 1); // the last good copy stays
});
