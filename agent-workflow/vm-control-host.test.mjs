// The host the dok supervisor registers for the Hub's VM control operations (plxzy/vm#806). Temp dirs only: the real
// supervisor, grant provider and stdio door run against the synthetic fixture helper; no real service, credential,
// listener or host state is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VmControlHost, createVmControlHost, parseVmControlConfig, MAX_WAIT_MS } from './vm-control-host.mjs';
import { FileIntentStore, StdioDoor, VmControlSupervisor } from './vm-control-supervisor.mjs';
import { VmProjectGrants } from './vm-control-grants.mjs';
import { validateDevelopment } from './dev-contract.mjs';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/vm-control-fixture-helper.mjs');
const CREDENTIAL = 'synthetic-credential-0001';
const PRINCIPAL = 'hub-mcp', OWNER = 'fixture-owner', BACKING = '0123456789abcdef';
const MUTATION = /^vmc-[0-9a-f]{32}$/;
let keys = 0;
const nextKey = () => `request-key-${String(++keys).padStart(4, '0')}`;
const intent = (over = {}) => ({ format: 1, operation: 'stop', target: 'browser', hostId: 'fixture-host', service: 'fixture-service',
  projectId: 'fixture-project', worker: 'container', workerGeneration: 'fixture-generation', backingId: BACKING, ...over });

function world(t, { grants = ['mutate', 'read'], waitMs, daemon = {}, wrapDoor = d => d } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-control-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), fixture = path.join(home, 'fixture');
  fs.mkdirSync(path.join(fixture, 'flags'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/vmservice-node'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/vmservice-node/control.token'), CREDENTIAL + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, 'daemon.json'), JSON.stringify({ serviceId: 'fixture-service', worker: 'container', generation: 'fixture-generation',
    backing: BACKING, claims: {}, effects: {}, ...daemon }));
  const credentialFile = path.join(root, 'door.credential');
  fs.writeFileSync(credentialFile, CREDENTIAL + '\n', { mode: 0o600 });
  const clock = { t: 1_000_000, now: () => clock.t, sleep: async ms => { clock.t += ms; } };
  const stateDir = path.join(root, 'vm-control');
  const config = { owners: [OWNER], doors: { 'door-1': { helper: HELPER, env: { HOME: home, PATH: process.env.PATH }, credentialFile } }, ...(waitMs ? { waitMs } : {}) };
  const w = {
    root, home, clock, stateDir, config, credentialFile,
    // A (re)started host over the same durable state: new process epoch, nothing carried in memory.
    boot: () => createVmControlHost(config, { stateDir, clock, now: clock.now }),
    flag: name => fs.writeFileSync(path.join(fixture, 'flags', name), ''),
    calls: () => (fs.existsSync(path.join(fixture, 'calls.jsonl')) ? fs.readFileSync(path.join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    count: op => w.calls().filter(c => c.op === op).length,
    daemon: () => JSON.parse(fs.readFileSync(path.join(fixture, 'daemon.json'), 'utf8')),
  };
  const host = w.boot();
  host.enrollment.enroll(OWNER, 'fixture-project', { hostId: 'fixture-host', service: 'fixture-service', doorRef: 'door-1', workers: ['container'],
    targets: ['backing', 'browser'], operations: ['start', 'stop', 'restart'] });
  const ids = {};
  const decide = (mode) => {
    const pending = host.enrollment.request(PRINCIPAL, `req-${mode}`, { projectId: 'fixture-project', mode });
    host.enrollment.decide(OWNER, pending.grant_id, 'approve', host.enrollment.issue(OWNER, pending.grant_id, 'approve'));
    ids[mode] = pending.grant_id;
  };
  for (const mode of grants) decide(mode);
  w.host = host; w.revoke = mode => host.enrollment.decide(OWNER, ids[mode], 'revoke', host.enrollment.issue(OWNER, ids[mode], 'revoke'));
  // Same state, but the door is wrapped (slow, counted): a host built straight from the supervisor parts.
  w.wrapped = ({ wrap, waitMs: wait }) => {
    const door = wrap(new StdioDoor({ helper: HELPER, env: { HOME: home, PATH: process.env.PATH }, credential: CREDENTIAL }));
    const supervisor = new VmControlSupervisor({ enrollment: host.enrollment, store: new FileIntentStore(path.join(stateDir, 'intents'), { now: clock.now }), doors: () => door, clock });
    return new VmControlHost({ supervisor, waitMs: wait, now: clock.now });
  };
  return w;
}
const submit = (host, key, i = intent(), principal = PRINCIPAL) => host.execute('vm_control_submit', { principal, request_key: key, intent: i });
const get = (host, id, extra = {}, principal = PRINCIPAL) => host.execute('vm_control_get', { principal, mutation_id: id, ...extra });

test('a granted submit sends one exact intent and answers the contract projection plus the Hub view', async t => {
  const w = world(t);
  const answer = await submit(w.host, nextKey());
  assert.equal(answer.ok, true);
  const { response, view } = answer.value;
  assert.equal(response.state, 'confirmed');
  assert.equal(response.source, 'service-door');
  assert.match(response.request.mutationId, MUTATION);
  assert.deepEqual({ ...response.request, mutationId: undefined }, { format: 1, kind: 'control', ...intent(), mutationId: undefined });
  assert.equal(view.label, 'Browser stop (not a backing stop)');
  assert.equal(view.provenance.settledByService, true);
  assert.equal('evidence' in view, false, 'the view does not repeat the response evidence');
  assert.equal(w.count('control-worker'), 1);
  assert.equal(w.daemon().effects['browser-stop'], 1);
  await w.host.idle();
  assert.equal(w.count('get-control-receipt'), 0, 'a definite answer schedules no receipt read');
});

test('repeating the request key reads the original outcome and sends nothing; a conflicting intent is refused', async t => {
  const w = world(t);
  const key = nextKey();
  const first = await submit(w.host, key);
  const again = await submit(w.host, key);
  assert.deepEqual(again.value.response, first.value.response);
  assert.equal(w.count('control-worker'), 1);
  const conflict = await submit(w.host, key, intent({ operation: 'restart' }));
  assert.equal(conflict.value.response.error.code, 'request-key-conflict');
  assert.equal(conflict.value.response.request, null);
  assert.equal(conflict.value.view, null);
  assert.equal(w.count('control-worker'), 1);
});

test('no grant: refused at admission with a null request, and the helper is never launched', async t => {
  const w = world(t, { grants: [] });
  const answer = await submit(w.host, nextKey());
  assert.equal(answer.value.response.source, 'admission');
  assert.equal(answer.value.response.state, 'refused');
  assert.equal(answer.value.response.request, null);
  assert.deepEqual(w.calls(), []);
  const read = await submit(world(t, { grants: ['read'] }).host, nextKey());
  assert.equal(read.value.response.source, 'admission', 'a read grant never authorizes a mutation');
});

test('a malformed intent is rejected before any helper launch with a bounded message', async t => {
  const w = world(t);
  for (const bad of [intent({ backingId: undefined }), { ...intent(), command: 'ls' }, intent({ target: 'backing', operation: 'restart' }), intent({ operation: 'recovery-reset' }), 'nope', null]) {
    const answer = await submit(w.host, nextKey(), bad);
    assert.equal(answer.ok, false, JSON.stringify(bad));
    assert.equal(answer.kind, 'rejected');
    assert.match(answer.error, /^[A-Za-z0-9 ;:.,_-]{1,180}$/);
  }
  assert.deepEqual(w.calls(), []);
});

test('a lost reply is unknown, then the background read confirms it once; no second mutation', async t => {
  const w = world(t);
  w.flag('drop-reply');
  const answer = await submit(w.host, nextKey());
  assert.equal(answer.value.response.state, 'unknown');
  assert.equal(answer.value.response.source, 'transport');
  await w.host.idle();
  const id = answer.value.response.request.mutationId;
  const read = await get(w.host, id);
  assert.equal(read.value.response.state, 'confirmed', 'the receipt read confirmed the original intent');
  assert.equal(read.value.response.request.kind, 'control');
  assert.equal(w.count('control-worker'), 1);
  assert.equal(w.count('get-control-receipt'), 1);
  assert.equal(Object.values(w.daemon().effects).reduce((a, b) => a + b, 0), 1);
});

test('a slow call answers in-flight inside the relay window, keeps running, and the same key then reads its outcome', async t => {
  const w = world(t);
  let release;
  const gate = new Promise(r => { release = r; });
  const host = w.wrapped({ waitMs: 20, wrap: door => ({ call: async (body, opts) => { if (body.operation === 'control-worker') await gate; return door.call(body, opts); } }) });
  const key = nextKey();
  const waiting = await submit(host, key);
  assert.deepEqual(waiting, { ok: true, value: { status: 'in-flight', request_key: key } });
  assert.equal(w.count('control-worker'), 0);
  const second = await submit(host, key);
  assert.equal(second.value.status, 'in-flight', 'a repeat while running joins the same work');
  release();
  let done;
  for (let i = 0; i < 100; i++) { done = await submit(host, key); if (done.value.status !== 'in-flight') break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(done.value.response.state, 'confirmed');
  assert.equal(w.count('control-worker'), 1);
});

test('get: a recorded read contacts no service; refresh makes one receipt read and never a control call', async t => {
  const w = world(t);
  const id = (await submit(w.host, nextKey())).value.response.request.mutationId;
  const before = w.calls().length;
  const recorded = await get(w.host, id);
  assert.equal(recorded.value.response.state, 'confirmed');
  assert.equal(w.calls().length, before, 'no helper launch for a recorded read');
  const refreshed = await get(w.host, id, { refresh: true });
  assert.equal(refreshed.value.response.state, 'confirmed');
  assert.equal(w.count('get-control-receipt'), 1);
  assert.equal(w.count('control-worker'), 1);
});

test('get: another principal or an unknown id sees nothing; a revoked read grant refuses at admission', async t => {
  const w = world(t);
  const id = (await submit(w.host, nextKey())).value.response.request.mutationId;
  assert.equal((await get(w.host, id, {}, 'someone-else')).ok, false);
  assert.equal((await get(w.host, 'vmc-' + '0'.repeat(32))).ok, false);
  w.revoke('read');
  const denied = await get(w.host, id);
  assert.equal(denied.value.response.source, 'admission');
  assert.equal(denied.value.response.state, 'refused');
  assert.equal(denied.value.response.request.kind, 'receipt', 'a refused read of an existing intent still carries its request');
  const refresh = await get(w.host, id, { refresh: true });
  assert.equal(refresh.value.response.source, 'admission');
  assert.equal(w.count('get-control-receipt'), 0);
});

test('boot recovery resumes unfinished receipt reads from the persisted state and never sends', async t => {
  const w = world(t);
  const first = w.host;
  first.stop(); // the process dies before any background read runs
  w.flag('drop-reply');
  const answer = await submit(first, nextKey());
  assert.equal(answer.value.response.state, 'unknown');
  assert.equal(w.count('get-control-receipt'), 0);
  const second = w.boot();
  second.start();
  await second.idle();
  const read = await get(second, answer.value.response.request.mutationId);
  assert.equal(read.value.response.state, 'confirmed');
  assert.equal(w.count('control-worker'), 1);
  assert.equal(w.count('get-control-receipt'), 1);
});

test('the receipt poll budget survives restarts: three reads in total, then nothing more is read automatically', async t => {
  const w = world(t);
  w.flag('effect-fails'); // the service settles an uncertain effect: unknown on every read, so the whole budget is used
  const answer = await submit(w.host, nextKey());
  await w.host.idle();
  assert.equal(answer.value.response.state, 'unknown');
  assert.equal(w.count('get-control-receipt'), 3, 'three automatic reads, no more');
  const next = w.boot();
  next.start();
  await next.idle();
  assert.equal(w.count('get-control-receipt'), 3, 'a restart cannot reset the budget');
  assert.equal(w.count('control-worker'), 1);
});

test('unknown operations are rejected and config is checked before anything is built', async t => {
  const w = world(t);
  assert.equal((await w.host.execute('dev_prepare', {})).ok, false);
  const good = w.config;
  const bad = [{ ...good, extra: 1 }, { ...good, owners: [] }, { ...good, doors: {} }, { ...good, waitMs: MAX_WAIT_MS + 1 },
    { ...good, doors: { 'door-1': { ...good.doors['door-1'], helper: 'relative/helper' } } },
    { ...good, doors: { 'door-1': { ...good.doors['door-1'], env: { PATH: '/usr/bin' } } } },
    { ...good, doors: { 'door-1': { ...good.doors['door-1'], extra: true } } },
    { ...good, doors: { '../escape': good.doors['door-1'] } }];
  for (const config of bad) assert.throws(() => parseVmControlConfig(config), undefined, JSON.stringify(config).slice(0, 80));
  fs.chmodSync(w.credentialFile, 0o644);
  assert.throws(() => createVmControlHost(good, { stateDir: path.join(w.root, 'other') }), /private/);
  fs.chmodSync(w.credentialFile, 0o600);
  fs.writeFileSync(w.credentialFile, '', { mode: 0o600 });
  assert.throws(() => createVmControlHost(good, { stateDir: path.join(w.root, 'other') }), /empty/);
});

test('the relay host operation schemas take exactly the fields the host reads', () => {
  const key = 'request-key-0001', principal = 'hub-mcp';
  validateDevelopment('vm_control_submit', { principal, request_key: key, intent: intent() }, true);
  validateDevelopment('vm_control_get', { principal, mutation_id: 'vmc-' + 'a'.repeat(32) }, true);
  validateDevelopment('vm_control_get', { principal, mutation_id: 'vmc-' + 'a'.repeat(32), refresh: true }, true);
  for (const [op, args] of [['vm_control_submit', { principal, request_key: key, intent: intent(), request_id: 'extra-field-1' }], ['vm_control_submit', { request_key: key, intent: intent() }],
    ['vm_control_submit', { principal, request_key: 'short', intent: intent() }], ['vm_control_get', { principal, mutation_id: 'not-an-id' }],
    ['vm_control_get', { principal, mutation_id: 'vmc-' + 'a'.repeat(32), refresh: 'yes' }]]) assert.throws(() => validateDevelopment(op, args, true), undefined, op);
});
