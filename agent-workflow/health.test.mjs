import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { healthOf, healthTime, healthLabels } from './health.mjs';
import { doctorHealth, doctorInput } from './doctor.mjs';
import { dashboardHtml } from './ui/dashboard.mjs';

const now = Date.parse('2026-10-09T15:00:00.000Z');
const at = (ago = 0) => new Date(now - ago).toISOString();
const data = () => ({ capabilities: { run: false, mutate: false },
  snapshot: { generated_at: at(1000), published_at: at(500), stale: false },
  relay_source: 'Durable Object status',
  relay: { online: true, enabled: true, agents: ['helper'], observed_at: at(), last_seen_at: at(1000), protocol_version: 1 } });
const report = (d) => healthOf(d, { now });

for (const enabled of [true, false]) test(`connected/${enabled ? 'enabled' : 'off'} keeps snapshot capabilities separate`, () => {
  const d = data(); d.relay.enabled = enabled;
  const before = structuredClone(d), h = report(d);
  assert.equal(h.relay.state, 'connected'); assert.equal(h.relay.freshness, 'fresh');
  assert.equal(h.execution.enabled, enabled); assert.equal(h.execution.available, enabled);
  assert.equal(h.exit_code, 0); assert.equal(h.snapshot.capabilities.run, false);
  assert.equal(h.allowlist.authority, 'live'); assert.equal(h.allowlist.matches_expected, true);
  assert.equal(h.versions.relay_protocol, 1); assert.equal(h.snapshot.age_ms, 1000);
  assert.deepEqual(d, before, 'normalizing must not mutate source or permissions');
  if (!enabled) assert.match(h.execution.reason, /not an outage/);
});

for (const stale of [false, true]) test(`offline with ${stale ? 'stale' : 'fresh'} snapshot preserves last-known allowlist`, () => {
  const d = data(); d.snapshot.generated_at = at(stale ? 900001 : 1000); d.snapshot.stale = stale;
  d.relay = { online: false, enabled: false, agents: [], observed_at: at(), last_seen_at: at(40000),
    last_known: { agents: ['helper'], enabled: true, observed_at: at(60000) } };
  const h = report(d);
  assert.equal(h.relay.state, 'disconnected'); assert.equal(h.relay.freshness, 'stale');
  assert.equal(h.snapshot.state, stale ? 'stale' : 'fresh');
  assert.equal(h.execution.enabled, null, 'legacy offline enabled=false is not an off-switch observation');
  assert.equal(h.execution.available, false); assert.equal(h.allowlist.authority, 'last-known');
  assert.deepEqual(h.allowlist.observed, ['helper']); assert.equal(h.allowlist.observed_at, at(60000));
  assert.equal(h.exit_code, 1); assert.match(healthLabels(h).join('\n'), /last-known/);
});

test('unknown booleans, missing history and unavailable allowlist remain unknown', () => {
  assert.equal(report(null).exit_code, 2);
  const h = report({ relay: { online: 'yes', enabled: 1, agents: null } });
  assert.equal(h.relay.state, 'unknown'); assert.equal(h.execution.enabled, null);
  assert.equal(h.execution.available, null); assert.equal(h.allowlist.observed, null);
  assert.equal(h.allowlist.matches_expected, null); assert.equal(h.last_successful_relay_run, null);
  assert.match(h.history_limitation, /origin/); assert.equal(h.snapshot.state, 'unavailable'); assert.equal(h.exit_code, 2);
  const d = data(); delete d.relay.agents;
  assert.equal(report(d).exit_code, 2); assert.equal(report(d).execution.available, null);
  d.relay.available = false; d.relay.last_seen_at = at(60000); assert.equal(report(d).relay.state, 'unknown');
});

test('malformed, normalized-invalid and future timestamps never become age zero or healthy', () => {
  for (const invalid of ['not a date', '2026-02-30T01:00:00.000Z', '2026-10-09T15:00:01.000Z', '', 0]) {
    assert.equal(healthTime(invalid, now).at, null); assert.equal(healthTime(invalid, now).age_ms, null);
    const d = data(); d.snapshot.generated_at = invalid;
    assert.equal(report(d).snapshot.state, 'unknown'); assert.equal(report(d).snapshot.age_ms, null);
    d.snapshot.generated_at = at(); d.relay.last_seen_at = invalid;
    assert.equal(report(d).relay.state, 'unknown'); assert.equal(report(d).execution.available, null);
  }
  const d = data(); d.snapshot.published_at = at(-1);
  assert.equal(report(d).snapshot.state, 'unknown');
  delete d.snapshot.published_at; assert.equal(report(d).snapshot.state, 'unknown');
  d.relay.observed_at = at(-1); assert.equal(report(d).exit_code, 2);
});

test('an old online observation expires into last-known information, not new execution authority', () => {
  const d = data(); d.relay.observed_at = at(30000); d.relay.last_seen_at = at(31000);
  const h = report(d); assert.equal(h.relay.state, 'disconnected'); assert.equal(h.execution.available, false);
  assert.equal(h.allowlist.authority, 'last-known'); assert.equal(h.allowlist.observed_at, at(30000));
});

test('allowlist mismatch is diagnostic only and does not change the helper expectation', () => {
  const d = data(); d.relay.agents = ['helper', 'network']; const before = structuredClone(d);
  const h = report(d); assert.equal(h.exit_code, 1); assert.equal(h.execution.available, false);
  assert.deepEqual(h.allowlist.expected, ['helper']); assert.equal(h.allowlist.matches_expected, false);
  assert.deepEqual(d, before); assert.match(healthLabels(h).join('\n'), /MISMATCH/);
});

test('older observations without timestamps are compatible but do not establish fresh permission', () => {
  const d = data(); delete d.relay.observed_at; delete d.relay.last_seen_at;
  const h = report(d); assert.equal(h.relay.state, 'connected'); assert.equal(h.relay.freshness, 'unknown');
  assert.equal(h.execution.enabled, null); assert.equal(h.exit_code, 2);
  assert.equal(d.capabilities.run, false); assert.deepEqual(d.relay.agents, ['helper']);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state'), journal = path.join(root, 'journal');
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true }); fs.mkdirSync(path.join(journal, 'runs'), { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  return { root, state, journal, write };
}

test('local doctor proves origin with existing journal and completion receipts, never recent ordinary runs', (t) => {
  const f = fixture(t);
  f.write(path.join(f.journal, 'runs/r-old.json'), { request_id: 'request-old' });
  f.write(path.join(f.journal, 'request-old.json'), { state: 'done', value: { run_id: 'r-old' } });
  f.write(path.join(f.state, 'runs/r-old.json'), { run_id: 'r-old', status: 'completed', ended: at(3600000) });
  f.write(path.join(f.state, 'runs/r-ordinary.json'), { run_id: 'r-ordinary', status: 'completed', ended: at(1) });
  f.write(path.join(f.journal, 'runs/r-future.json'), { request_id: 'request-future' });
  f.write(path.join(f.journal, 'request-future.json'), { state: 'done', value: { run_id: 'r-future' } });
  f.write(path.join(f.state, 'runs/r-future.json'), { run_id: 'r-future', status: 'completed', ended: at(-1) });
  const config = { enabled: false, agents: ['helper'], token: 'synthetic-not-for-output' };
  const before = fs.readFileSync(path.join(f.journal, 'request-old.json'), 'utf8');
  const h = doctorHealth({ ...f, readConfig: () => config, sandboxed: false, now });
  assert.equal(h.last_successful_relay_run.run_id, 'r-old'); assert.equal(h.last_successful_relay_run.historical, true);
  assert.equal(h.last_successful_relay_run.ended, at(3600000)); assert.equal(h.execution.configured_enabled, false);
  assert.equal(h.execution.enabled, null); assert.equal(h.relay.state, 'unknown'); assert.equal(h.exit_code, 2);
  assert.doesNotMatch(JSON.stringify(h), /synthetic-not-for-output/);
  assert.equal(fs.readFileSync(path.join(f.journal, 'request-old.json'), 'utf8'), before);
});

test('default sandbox doctor does not access private config/history or call mutations', () => {
  let calls = 0;
  const h = doctorHealth({ sandboxed: true, readConfig: () => { calls++; assert.fail('private access'); }, state: '/unavailable', journal: '/unavailable', now });
  assert.equal(calls, 0); assert.equal(h.exit_code, 2); assert.match(h.history_limitation, /sandbox/);
  assert.equal(h.allowlist.configured, null); assert.equal(h.last_successful_relay_run, null);
});

test('doctor input rechecks observation times and cannot attest journal origin', (t) => {
  const f = fixture(t), file = path.join(f.root, 'observations.json');
  const d = data(); d.last_successful_relay_run = { origin: 'relay-journal', run_id: 'r-invented', ended: at() };
  f.write(file, d); const h = doctorInput(file, { now });
  assert.equal(h.last_successful_relay_run, null); assert.equal(h.exit_code, 0);
  assert.match(h.relay.source, /not refreshed/);
  assert.equal(doctorInput(file, { now: now + 60000 }).exit_code, 1);
  f.write(file, []); assert.throws(() => doctorInput(file, { now }), /raw get_status/);
});

test('normal local health path never calls process, mutation, network or timer APIs', (t) => {
  const f = fixture(t), calls = [], originals = [];
  const trap = (object, key) => { originals.push([object, key, object[key]]); object[key] = () => { calls.push(key); throw new Error('forbidden health side effect'); }; };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) trap(childProcess, key);
  for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync']) trap(fs, key);
  for (const key of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm']) trap(fs.promises, key);
  for (const key of ['fetch', 'setTimeout', 'setInterval']) trap(globalThis, key);
  syncBuiltinESMExports();
  try {
    const h = doctorHealth({ ...f, sandboxed: false, readConfig: () => ({ enabled: true, agents: ['helper'] }), now });
    assert.equal(h.exit_code, 2); assert.deepEqual(calls, []);
    assert.equal(report(data()).exit_code, 0); assert.deepEqual(calls, []);
  } finally { for (const [object, key, value] of originals.reverse()) object[key] = value; syncBuiltinESMExports(); }
});

test('CLI doctor is one-shot JSON with documented 0/1/2 exits, not another model invocation', (t) => {
  const f = fixture(t), file = path.join(f.root, 'observations.json');
  const cli = new URL('./agent.mjs', import.meta.url).pathname;
  const run = (...args) => childProcess.spawnSync(process.execPath, [cli, 'link', 'doctor', '--json', ...args], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, AGENT_SANDBOXED: '1' } });
  const d = data(), stamp = new Date().toISOString();
  d.relay.observed_at = d.relay.last_seen_at = d.snapshot.generated_at = d.snapshot.published_at = stamp;
  d.relay.enabled = false; f.write(file, d);
  let result = run('--input', file); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).execution.enabled, false);
  d.relay.online = false; f.write(file, d); result = run('--input', file); assert.equal(result.status, 1, result.stderr);
  result = run(); assert.equal(result.status, 2, result.stderr); assert.equal(JSON.parse(result.stdout).execution.enabled, null);
  assert.match(JSON.parse(result.stdout).history_limitation, /sandbox/);
  result = run('--unexpected'); assert.equal(result.status, 1); assert.match(result.stderr, /Usage/);
});

test('dashboard embeds and executes the same pure health code without network dependencies', () => {
  const html = dashboardHtml({ bridge: 'globalThis.ExtApps={};' });
  assert.doesNotMatch(html, /__HEALTH_BUNDLE__|<script[^>]+src=/);
  const script = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('globalThis.AgentsHealth ='));
  const context = vm.createContext({}); vm.runInContext(script, context);
  const actual = context.AgentsHealth.healthOf(data(), { now });
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), report(data()));
  assert.deepEqual(Array.from(context.AgentsHealth.healthLabels(actual)), healthLabels(report(data())));
  assert.match(html, /Only live panel_data can expose remote Run controls/);
  assert.match(html, /a\.remote_allowed === true/);
});
