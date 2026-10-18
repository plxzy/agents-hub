// Synthetic acceptance for the supervisor-owned VM control seam (plxzy/vm#806). Temp dirs only. The door spawns a
// fixture helper that speaks vmservice-call's wire and mirrors the daemon's journal/replay/conflict rules; nothing here
// touches a real service, credential, listener or host state. The vm repo runs the same supervisor against the real
// helper and fake engine (service/tests/test_supervisor_seam.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnrollmentGrants, FileIntentStore, StdioDoor, VmControlSupervisor } from './vm-control-supervisor.mjs';
import { VmControlProjection, projectIntent } from './vm-control-projection.mjs';
import { ACTIONS, LIMITS, daemonBody, parseReply, parseStrictJson, validateRequest } from './vm-control-contract.mjs';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/vm-control-fixture-helper.mjs');
const CREDENTIAL = 'synthetic-credential-0001';
const PRINCIPAL = 'fixture-principal';
const BACKING = '0123456789abcdef';
let keys = 0;
const nextKey = () => `request-key-${++keys}`;

function world(t, { daemon = {}, doorLimits = {}, wrapDoor = d => d, limits = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-control-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), fixture = path.join(home, 'fixture');
  fs.mkdirSync(path.join(fixture, 'flags'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/vmservice-node'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/vmservice-node/control.token'), CREDENTIAL + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, 'daemon.json'), JSON.stringify({ serviceId: 'fixture-service', worker: 'container', generation: 'fixture-generation',
    backing: BACKING, claims: {}, effects: {}, ...daemon }));
  const clock = { t: 1_000_000, sleeps: [], now: () => clock.t, sleep: async ms => { clock.sleeps.push(ms); clock.t += ms; } };
  const enrollment = new EnrollmentGrants({ now: clock.now });
  enrollment.enroll('fixture-project', { hostId: 'fixture-host', service: 'fixture-service', doorRef: 'door-1', workers: ['container'],
    targets: ['backing', 'browser'], operations: ['start', 'stop', 'restart'] });
  enrollment.grant('write-1', { principal: PRINCIPAL, projectId: 'fixture-project', mode: 'mutate' });
  enrollment.grant('read-1', { principal: PRINCIPAL, projectId: 'fixture-project', mode: 'read' });
  const door = wrapDoor(new StdioDoor({ helper: HELPER, env: { HOME: home, PATH: process.env.PATH }, credential: CREDENTIAL, limits: doorLimits }));
  const storeDir = path.join(root, 'supervisor-state');
  const w = {
    root, home, clock, enrollment, door, storeDir,
    // A (re)started supervisor over the same durable state: new process epoch, nothing carried in memory.
    boot: (options = {}) => new VmControlSupervisor({ enrollment, store: new FileIntentStore(storeDir, { now: clock.now }), doors: () => door, clock, limits, ...options }),
    flag: name => fs.writeFileSync(path.join(fixture, 'flags', name), ''),
    daemon: () => JSON.parse(fs.readFileSync(path.join(fixture, 'daemon.json'), 'utf8')),
    calls: () => (fs.existsSync(path.join(fixture, 'calls.jsonl')) ? fs.readFileSync(path.join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    count: op => w.calls().filter(c => c.op === op).length,
    stored: () => fs.existsSync(storeDir) ? fs.readdirSync(storeDir).map(f => fs.readFileSync(path.join(storeDir, f), 'utf8')) : [],
  };
  return w;
}
const intent = (over = {}) => ({ format: 1, operation: 'stop', target: 'browser', hostId: 'fixture-host', service: 'fixture-service',
  projectId: 'fixture-project', worker: 'container', workerGeneration: 'fixture-generation', backingId: BACKING, ...over });
const TUPLE = ['hostId', 'service', 'projectId', 'worker', 'workerGeneration', 'backingId'];
const tupleOf = r => Object.fromEntries(TUPLE.map(k => [k, r[k]]));

test('acceptance 1+2: a dropped reply after the daemon settled is unknown, then recovers by receipt read only, one effect', async t => {
  const w = world(t);
  w.flag('drop-reply');
  const first = w.boot();
  const sent = await first.submit(PRINCIPAL, nextKey(), intent());
  assert.equal(sent.state, 'unknown');
  assert.equal(sent.source, 'transport');
  assert.equal(sent.reply, null);
  assert.equal(sent.error.code, 'reply-unavailable');
  assert.deepEqual(tupleOf(sent.request), tupleOf(intent()));
  assert.equal(sent.request.kind, 'control');
  assert.equal(sent.request.target, 'browser');
  assert.equal(sent.request.operation, 'stop');
  assert.match(sent.request.mutationId, /^vmc-[0-9a-f]{32}$/);
  assert.equal(w.daemon().effects['browser-stop'], 1);
  assert.equal(w.count('control-worker'), 1);
  const view = new VmControlProjection(first.store.readOnly(), { now: w.clock.now, liveEpoch: first.epoch }).get(sent.request.mutationId);
  assert.equal(view.state, 'unknown');
  assert.equal(view.label, 'Browser stop (not a backing stop)');
  assert.deepEqual(view.tuple, { ...tupleOf(sent.request), mutationId: sent.request.mutationId });

  // The supervisor restarts: new epoch, same durable state. Hub shows the same unknown; nothing is redispatched yet.
  const second = w.boot();
  assert.equal(new VmControlProjection(second.store.readOnly(), { now: w.clock.now, liveEpoch: second.epoch }).get(sent.request.mutationId).state, 'unknown');
  const results = await second.pollUnresolved();
  assert.deepEqual(results.map(([, r]) => r.status), ['settled']);
  const final = second.response(sent.request.mutationId);
  assert.equal(final.state, 'confirmed');
  assert.equal(final.source, 'service-door');
  assert.equal(final.reply.result.replayed, true);
  assert.deepEqual(final.request, sent.request, 'the original intent, byte for byte');
  assert.equal(w.daemon().effects['browser-stop'], 1, 'a receipt read must not repeat the effect');
  assert.equal(w.count('control-worker'), 1, 'never resend control-worker');
  assert.ok(w.count('get-control-receipt') >= 1);
  const projected = new VmControlProjection(second.store.readOnly(), { now: w.clock.now, liveEpoch: second.epoch }).get(sent.request.mutationId);
  assert.equal(projected.state, 'confirmed');
  assert.equal(projected.provenance.settledByService, true);
  assert.equal(projected.note, 'Receipt confirmation is not current worker health.');
  for (const text of [...w.stored(), JSON.stringify(projected), JSON.stringify(final)]) assert.ok(!text.includes(CREDENTIAL), 'no credential in durable or Hub output');
  assert.deepEqual(process.getActiveResourcesInfo().filter(r => /Server/.test(r)), [], 'no listener');
});

test('the intent is durable before anything is written to the door, and a crash before the reply is recorded is unknown, never a resend', async t => {
  const w = world(t);
  const seen = [];
  let store;
  const crashing = {
    call: async body => {
      if (body.operation === 'control-worker') {
        const [record] = store.list();
        seen.push({ phase: record.phase, tuple: tupleOf(record.request), mutationId: record.request.mutationId, wire: body.mutationId });
        return new Promise(() => {});   // the supervisor "dies" with the request possibly sent
      }
      return w.door.call(body, {});
    },
  };
  const a = w.boot({ doors: () => crashing });
  store = a.store;
  void a.submit(PRINCIPAL, nextKey(), intent());
  await new Promise(r => setTimeout(r, 400));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].tuple, tupleOf(intent()));
  assert.equal(seen[0].phase, 'sending');
  assert.equal(seen[0].mutationId, seen[0].wire);
  assert.equal(w.count('control-worker'), 0, 'the daemon never saw it');

  const b = w.boot();
  const [id] = b.recover();
  assert.equal(id, seen[0].mutationId);
  assert.equal(b.response(id).state, 'unknown');
  assert.equal(b.response(id).error.code, 'reply-unavailable');
  assert.equal(new VmControlProjection(b.store.readOnly(), { now: w.clock.now, liveEpoch: b.epoch }).get(id).state, 'unknown');
  // The daemon has no claim: absent is safe, consumes budget, and never becomes a dispatch.
  const result = await b.poll(id);
  assert.equal(result.status, 'exhausted');
  assert.equal(b.response(id).state, 'absent');
  assert.equal(w.count('control-worker'), 0);
  assert.equal(w.count('get-control-receipt'), LIMITS.polls);
  assert.deepEqual(w.clock.sleeps, [LIMITS.pollGapMs, LIMITS.pollGapMs]);
  assert.equal(w.daemon().effects['browser-stop'], undefined);
});

const UNSETTLED = [
  { name: 'settled uncertain effect', flags: ['effect-fails'], first: { state: 'unknown', source: 'service-door' }, final: 'unknown', effects: undefined },
  { name: 'unsettled crash claim without attributable evidence', flags: ['crash-after-claim'], first: { state: 'unknown', source: 'transport' }, final: 'unknown', effects: undefined },
  { name: 'unsettled crash claim with attributable evidence', flags: ['crash-after-claim', 'effect-before-crash', 'evidence'], first: { state: 'unknown', source: 'transport' }, final: 'confirmed', effects: 1 },
];
for (const c of UNSETTLED) {
  test(`acceptance 3: ${c.name}`, async t => {
    const w = world(t);
    for (const f of c.flags) w.flag(f);
    const a = w.boot();
    const sent = await a.submit(PRINCIPAL, nextKey(), intent());
    assert.deepEqual({ state: sent.state, source: sent.source }, c.first);
    const effectsAfterSend = w.daemon().effects['browser-stop'];
    const b = w.boot();
    await b.pollUnresolved();
    assert.equal(b.response(sent.request.mutationId).state, c.final);
    assert.equal(w.daemon().effects['browser-stop'], effectsAfterSend, 'receipt reads add zero effects');
    assert.equal(w.daemon().effects['browser-stop'], c.effects);
    assert.equal(w.count('control-worker'), 1);
    if (c.final === 'confirmed') assert.equal(b.response(sent.request.mutationId).reply.result.reconciled, true);
    else assert.equal(w.count('get-control-receipt'), LIMITS.polls, 'unknown consumes the whole bounded budget and stays unknown');
  });
}

test('acceptance 3: the poll budget and deadline are persisted across a supervisor restart', async t => {
  const w = world(t);
  w.flag('drop-reply'); w.flag('effect-fails');           // reply lost; the daemon settled unknown, so it never resolves
  const a = w.boot();
  const sent = await a.submit(PRINCIPAL, nextKey(), intent());
  const id = sent.request.mutationId;
  // Crash during the batch: the second gap's sleep never returns, after two attempts were consumed.
  let sleeps = 0;
  const crashClock = { now: w.clock.now, sleep: async ms => { if (++sleeps === 2) throw new Error('process died'); await w.clock.sleep(ms); } };
  const crashing = w.boot({ clock: crashClock });
  await assert.rejects(crashing.poll(id), /process died/);
  assert.equal(w.count('get-control-receipt'), 2);
  const b = w.boot();
  assert.equal(b.store.get(id).poll.attempts, 2, 'attempts survive the restart');
  assert.equal((await b.poll(id)).status, 'exhausted');
  assert.equal(w.count('get-control-receipt'), LIMITS.polls, 'a restart cannot reset the budget');
  assert.equal((await w.boot().poll(id)).status, 'exhausted');
  assert.equal(w.count('get-control-receipt'), LIMITS.polls);
  assert.equal(w.count('control-worker'), 1);

  // The 210 s wall clock is also durable: a late restart finds the batch already out of time.
  const w2 = world(t);
  w2.flag('drop-reply'); w2.flag('effect-fails');
  const c = w2.boot();
  const id2 = (await c.submit(PRINCIPAL, nextKey(), intent())).request.mutationId;
  let step = 0;
  const slow = w2.boot({ clock: { now: w2.clock.now, sleep: async () => { if (++step === 1) throw new Error('died'); } } });
  await slow.poll(id2).catch(() => {});
  const used = w2.count('get-control-receipt');
  w2.clock.t += LIMITS.batchMs + 1;
  assert.equal((await w2.boot().poll(id2)).status, 'exhausted');
  assert.equal(w2.count('get-control-receipt'), used, 'no read after the deadline');
});

test('polls wait the minimum gap, stop early on a definite receipt, and a concurrent poll does not start a second loop', async t => {
  const w = world(t);
  w.flag('drop-reply');
  const a = w.boot();
  const id = (await a.submit(PRINCIPAL, nextKey(), intent())).request.mutationId;
  const [x, y] = await Promise.all([a.poll(id), a.poll(id)]);
  assert.deepEqual([x.status, y.status].sort(), ['already-running', 'settled']);
  assert.equal(w.count('get-control-receipt'), 1, 'stopped on the first definite receipt');
  assert.deepEqual(w.clock.sleeps, []);
});

test('acceptance 4: admission denials launch no helper at all', async t => {
  const w = world(t);
  w.enrollment.grant('write-expired', { principal: 'expired-principal', projectId: 'fixture-project', mode: 'mutate', expiresAt: w.clock.now() - 1 });
  w.enrollment.grant('write-revoked', { principal: 'revoked-principal', projectId: 'fixture-project', mode: 'mutate' });
  w.enrollment.revoke('write-revoked');
  w.enrollment.grant('read-only', { principal: 'reader', projectId: 'fixture-project', mode: 'read' });
  w.enrollment.enroll('narrow-project', { hostId: 'fixture-host', service: 'fixture-service', doorRef: 'door-1', workers: ['container'], targets: ['browser'], operations: ['stop'] });
  w.enrollment.grant('narrow', { principal: PRINCIPAL, projectId: 'narrow-project', mode: 'mutate' });
  const s = w.boot();
  const cases = [
    ['unenrolled project', PRINCIPAL, intent({ projectId: 'unknown-project' }), 'grant-denied'],
    ['wrong principal', 'someone-else', intent(), 'grant-denied'],
    ['expired grant', 'expired-principal', intent(), 'grant-denied'],
    ['revoked grant', 'revoked-principal', intent(), 'grant-denied'],
    ['a read grant is not a mutate grant', 'reader', intent(), 'grant-denied'],
    ['unenrolled worker', PRINCIPAL, intent({ worker: 'other-worker' }), 'grant-denied'],
    ['unenrolled target', PRINCIPAL, intent({ projectId: 'narrow-project', target: 'backing', operation: 'stop' }), 'grant-denied'],
    ['unenrolled operation', PRINCIPAL, intent({ projectId: 'narrow-project', operation: 'start' }), 'grant-denied'],
    ['wrong host pin', PRINCIPAL, intent({ hostId: 'another-host' }), 'identity-mismatch'],
    ['wrong service pin from the caller', PRINCIPAL, intent({ service: 'another-service' }), 'identity-mismatch'],
  ];
  for (const [name, principal, input, code] of cases) {
    const r = await s.submit(principal, nextKey(), input);
    assert.deepEqual({ state: r.state, source: r.source, code: r.error.code, reply: r.reply, request: r.request }, { state: 'refused', source: 'admission', code, reply: null, request: null }, name);
  }
  assert.equal(w.calls().length, 0, 'no helper launched');
  assert.equal(s.store.list().length, 0, 'no mutation id consumed');
});

test('acceptance 4: schema failures return exactly bad-request before any helper launch', async t => {
  const w = world(t);
  const s = w.boot();
  const { backingId, ...missing } = intent();
  const duplicate = JSON.stringify(intent()).replace('"worker":"container"', '"worker":"container","worker":"other"');
  const bads = {
    'missing backingId': missing, 'backing restart': intent({ target: 'backing', operation: 'restart' }), 'extra command': { ...intent(), command: 'docker rm' },
    'extra path': { ...intent(), path: '/tmp/x' }, 'unknown operation': intent({ operation: 'delete' }), 'unknown target': intent({ target: 'host' }),
    'caller-minted mutationId': { ...intent(), mutationId: 'mine-1' }, 'caller kind': { ...intent(), kind: 'control' }, 'coerced backing': intent({ backingId: 7 }),
    'uppercase backing': intent({ backingId: 'ABCDEF0123456789' }), 'short backing': intent({ backingId: 'abc' }), 'format 2': intent({ format: 2 }),
    'oversized id': intent({ worker: 'w'.repeat(201) }), 'empty id': intent({ projectId: '' }), 'duplicate JSON member': duplicate, 'not JSON': '{nope', 'array': [],
  };
  for (const [name, input] of Object.entries(bads)) {
    const r = await s.submit(PRINCIPAL, nextKey(), input);
    assert.deepEqual(Object.keys(r), ['error'], name);
    assert.equal(r.error.code, 'bad-request', name);
    assert.equal(typeof r.error.detail, 'string');
  }
  assert.equal(w.calls().length, 0);
  assert.throws(() => validateRequest({ ...intent(), kind: 'control', mutationId: 'm' , target: 'backing', operation: 'restart' }));
});

test('acceptance 4: a service-pin failure is refused after only a read-only identity check', async t => {
  const w = world(t, { daemon: { serviceId: 'a-different-service' } });
  const s = w.boot();
  const r = await s.submit(PRINCIPAL, nextKey(), intent());
  assert.deepEqual({ state: r.state, source: r.source, code: r.error.code }, { state: 'refused', source: 'admission', code: 'identity-mismatch' });
  assert.deepEqual(w.calls().map(c => c.op), ['status']);
  assert.equal(s.store.list().length, 0);
  assert.equal(w.daemon().effects['browser-stop'], undefined);
});

test('acceptance 4: stale generation or backing is refused by the daemon without retargeting; an explicit null backing is its own identity', async t => {
  const w = world(t);
  const s = w.boot();
  for (const [name, over] of [['generation', { workerGeneration: 'stale-generation' }], ['backing', { backingId: 'f'.repeat(64) }], ['null backing', { backingId: null }]]) {
    const r = await s.submit(PRINCIPAL, nextKey(), intent(over));
    assert.equal(r.state, 'refused', name);
    assert.equal(r.source, 'service-door', name);
    assert.equal(r.reply.status, 409, name);
    assert.deepEqual(tupleOf(r.request), tupleOf(intent(over)), `${name}: the stale tuple is preserved, not refreshed`);
    assert.equal((await s.poll(r.request.mutationId)).status, 'settled');
  }
  assert.equal(w.daemon().effects['browser-stop'], undefined);
  assert.equal(w.count('control-worker'), 3);
  assert.equal(w.count('get-control-receipt'), 0, 'a definite refusal needs no receipt polling');
  // A daemon that really has no backing accepts only the explicit null.
  const bare = world(t, { daemon: { backing: null } });
  const ok = await bare.boot().submit(PRINCIPAL, nextKey(), intent({ backingId: null }));
  assert.equal(ok.state, 'confirmed');
  assert.equal(ok.reply.result.backingId, null);
  assert.equal((await bare.boot().submit(PRINCIPAL, nextKey(), intent({ backingId: BACKING }))).state, 'refused');
});

test('acceptance 4: reusing a claimed mutation id for a different identity is a conflict, and the table is exactly the contract', async t => {
  const w = world(t);
  const sent = await w.boot().submit(PRINCIPAL, nextKey(), intent());
  assert.equal(sent.state, 'confirmed');
  const other = { ...sent.request, operation: 'restart' };
  const conflict = await w.door.call(daemonBody(other), { timeoutMs: 10000 });
  const parsed = parseReply(conflict.stdout);
  assert.equal(parsed.status, 409);
  assert.equal(parsed.error.code, 'mutation-conflict');
  const backing = await w.door.call(daemonBody({ ...sent.request, backingId: 'a'.repeat(64) }), { timeoutMs: 10000 });
  assert.equal(parseReply(backing.stdout).error.code, 'mutation-conflict');
  assert.equal(w.daemon().effects['browser-stop'], 1);
  assert.deepEqual(ACTIONS, { 'backing:start': 'backing-start', 'backing:stop': 'backing-stop', 'browser:start': 'browser-resume', 'browser:stop': 'browser-stop', 'browser:restart': 'browser-restart' });
});

test('acceptance 4: every admitted target/operation maps to its one action; a browser restart is never a backing restart', async t => {
  for (const [target, operation, action] of [['backing', 'start', 'backing-start'], ['backing', 'stop', 'backing-stop'],
    ['browser', 'start', 'browser-resume'], ['browser', 'stop', 'browser-stop'], ['browser', 'restart', 'browser-restart']]) {
    const w = world(t);
    const r = await w.boot().submit(PRINCIPAL, nextKey(), intent({ target, operation }));
    assert.equal(r.state, 'confirmed', `${target} ${operation}`);
    assert.equal(r.reply.result.action, action);
    assert.deepEqual(w.calls().map(c => c.action).filter(Boolean), [action]);
    const label = projectIntent(w.boot().store.list()[0], { liveEpoch: 'x' }).label;
    assert.equal(/not a VM\/backing restart/.test(label), target === 'browser' && operation === 'restart');
  }
});

test('read grants are independent: revoking mutation stops sends but not receipt reads; revoking reads stops reads', async t => {
  const w = world(t);
  w.flag('drop-reply');
  const s = w.boot();
  const id = (await s.submit(PRINCIPAL, nextKey(), intent())).request.mutationId;
  w.enrollment.revoke('write-1');
  assert.equal((await s.submit(PRINCIPAL, nextKey(), intent())).error.code, 'grant-denied');
  const before = w.calls().length;
  w.enrollment.revoke('read-1');
  const denied = await w.boot().poll(id);
  assert.deepEqual({ status: denied.status, code: denied.error.code }, { status: 'denied', code: 'grant-denied' });
  const refused = await w.boot().refresh(PRINCIPAL, id);
  assert.deepEqual({ state: refused.state, source: refused.source, kind: refused.request.kind }, { state: 'refused', source: 'admission', kind: 'receipt' });
  assert.equal(w.calls().length, before, 'no helper launch without a read grant');
  assert.equal(w.boot().response(id).state, 'unknown', 'earlier state is retained, not replaced');
  w.enrollment.grant('read-2', { principal: PRINCIPAL, projectId: 'fixture-project', mode: 'read' });
  assert.equal((await w.boot().poll(id)).status, 'settled');
  assert.equal(w.daemon().effects['browser-stop'], 1);
});

test('acceptance 5: truncated, oversized and hung replies are unknown; only receipt-read budget is spent; no resend', async t => {
  for (const [flag, doorLimits, helperMs, detail] of [['truncate-reply', {}, undefined, /incomplete|not JSON|unterminated/],
    ['oversize-reply', { stdoutBytes: 1024 }, undefined, /output bound/], ['hang-after-settle', {}, 1500, /deadline/]]) {
    const w = world(t, { doorLimits, limits: helperMs ? { helperMs } : {} });
    w.flag(flag);
    const s = w.boot();
    const sent = await s.submit(PRINCIPAL, nextKey(), intent());
    assert.deepEqual({ state: sent.state, source: sent.source, reply: sent.reply, code: sent.error.code }, { state: 'unknown', source: 'transport', reply: null, code: 'reply-unavailable' }, flag);
    assert.match(sent.error.detail, detail, flag);
    assert.equal(w.daemon().effects['browser-stop'], 1, flag);
    // Receipt reads keep failing: the whole batch is consumed and nothing but receipts is ever sent.
    const failing = { call: async (body, o) => (body.operation === 'get-control-receipt' ? { kind: 'failure', reason: 'timeout' } : w.door.call(body, o)) };
    const reads = w.boot({ doors: () => failing });
    assert.equal((await reads.poll(sent.request.mutationId)).status, 'exhausted', flag);
    assert.equal(reads.store.get(sent.request.mutationId).poll.attempts, LIMITS.polls, flag);
    assert.equal(w.count('control-worker'), 1, flag);
    assert.equal(w.daemon().effects['browser-stop'], 1, flag);
    assert.equal(reads.response(sent.request.mutationId).state, 'unknown', flag);
    assert.deepEqual(process.getActiveResourcesInfo().filter(r => /Server/.test(r)), [], flag);
  }
});

test('a receipt for another identity, an unrecognized state, extra lines or junk is a protocol failure, never evidence', async t => {
  const w = world(t);
  const base = { format: 1, serviceId: 'fixture-service', worker: 'container', workerGeneration: 'fixture-generation', backingId: BACKING, action: 'browser-stop', mutationId: null, state: 'confirmed', detail: '' };
  const cases = {
    'other backing': r => ({ ...r, backingId: null }), 'other generation': r => ({ ...r, workerGeneration: 'g2' }), 'other action': r => ({ ...r, action: 'browser-resume' }),
    'other service': r => ({ ...r, serviceId: 'another' }), 'other mutation': r => ({ ...r, mutationId: 'vmc-other' }), 'unrecognized state': r => ({ ...r, state: 'pending' }),
    'extra member': r => ({ ...r, surprise: 1 }),
  };
  for (const [name, change] of Object.entries(cases)) {
    let scripted;
    const door = { call: async body => (body.operation === 'status' ? w.door.call(body, {}) : { kind: 'bytes', stdout: Buffer.from(scripted(body)) }) };
    const s = w.boot({ doors: () => door });
    scripted = body => `{"status": 200, ${JSON.stringify({ result: change({ ...base, mutationId: body.mutationId }) }).slice(1)}\n`;
    const r = await s.submit(PRINCIPAL, nextKey(), intent());
    assert.deepEqual({ state: r.state, source: r.source, reply: r.reply }, { state: 'unknown', source: 'transport', reply: null }, name);
    assert.equal(s.store.get(r.request.mutationId).evidence, null, `${name}: never retained as service evidence`);
  }
  const shapes = ['', '{"status": 200', '{"status": 200, "result": {}}\n', 'noise\n{"status": 500, "error": {"code": "x", "detail": ""}}\n',
    '{"status": 500, "error": {"code": "x", "detail": ""}}\nnoise', '{"status": 200, "status": 200, "result": {}}\n', '{"status": 302, "error": {"code": "x", "detail": ""}}\n'];
  for (const text of shapes) assert.throws(() => parseReply(Buffer.from(text)), { code: 'reply-invalid' }, JSON.stringify(text));
  assert.equal(parseReply(Buffer.from('{"status": 502, "error": {"code": "service-unavailable", "detail": "x"}}\n \n')).status, 502);
  // A 5xx is retained but is not a refusal; a 4xx is a definite refusal.
  for (const [status, state] of [[502, 'unknown'], [504, 'unknown'], [400, 'refused'], [409, 'refused']]) {
    const door = { call: async body => (body.operation === 'status' ? w.door.call(body, {}) : { kind: 'bytes', stdout: Buffer.from(`{"status": ${status}, "error": {"code": "c", "detail": "d"}}\n`) }) };
    const r = await w.boot({ doors: () => door }).submit(PRINCIPAL, nextKey(), intent());
    assert.deepEqual({ state: r.state, source: r.source, status: r.reply.status, error: r.error }, { state: state, source: 'service-door', status: status, error: null });
  }
});

test('a settled receipt is sticky: a later failed read cannot erase it, and an explicit refresh never touches the poll budget', async t => {
  const w = world(t);
  const s = w.boot();
  const sent = await s.submit(PRINCIPAL, nextKey(), intent());
  const id = sent.request.mutationId;
  assert.equal(sent.state, 'confirmed');
  const failing = w.boot({ doors: () => ({ call: async (b, o) => (b.operation === 'get-control-receipt' ? { kind: 'failure', reason: 'exit' } : w.door.call(b, o)) }) });
  const refreshed = await failing.refresh(PRINCIPAL, id);
  assert.equal(refreshed.state, 'unknown');
  assert.equal(failing.response(id).state, 'confirmed');
  const view = projectIntent(failing.store.get(id), { now: w.clock.now(), liveEpoch: failing.epoch });
  assert.equal(view.state, 'confirmed');
  assert.equal(view.latestAttempt.state, 'unknown');
  assert.equal(failing.store.get(id).poll.attempts, 0);
  assert.equal((await w.boot().refresh('not-the-intent-owner', id)).error.code, 'bad-request');
});

test('Hub projection: pending only in the live process, lost-reply intents show unknown, stale evidence is labelled', async t => {
  const w = world(t);
  const store = new FileIntentStore(w.storeDir, { now: w.clock.now });
  const request = validateRequest({ ...intent(), kind: 'control', mutationId: 'vmc-' + '0'.repeat(32) });
  const record = { format: 1, request, principal: PRINCIPAL, epoch: 'epoch-a', createdAt: w.clock.now(), phase: 'sending', latest: null, evidence: null, settled: null,
    poll: { attempts: 0, batchStartedAt: null, batchDeadline: null, lastCompletedAt: null, active: null, exhausted: false } };
  assert.equal(projectIntent(record, { now: w.clock.now(), liveEpoch: 'epoch-a' }).state, 'pending');
  const lost = projectIntent(record, { now: w.clock.now(), liveEpoch: 'epoch-b' });
  assert.equal(lost.state, 'unknown');
  assert.equal(lost.evidence.error.code, 'reply-unavailable');
  const aged = projectIntent({ ...record, phase: 'settled', latest: { via: 'control', at: w.clock.now(), state: 'unknown', source: 'service-door', reply: null, error: null } },
    { now: w.clock.now() + 10 * 60 * 1000, liveEpoch: 'epoch-b' });
  assert.equal(aged.freshness.stale, true);
  assert.equal(store.list().length, 0, 'projection never writes');
});

test('contract: strict JSON rejects duplicate members at any depth and trailing bytes', () => {
  assert.deepEqual(parseStrictJson('{"a": [1, {"b": null}], "c": "\\u00e9"}'), { a: [1, { b: null }], c: 'é' });
  for (const bad of ['{"a":1,"a":2}', '{"x":{"a":1,"a":2}}', '[{"a":1,"a":1}]', '{"a":1} x', '{"a":01}', "{'a':1}", '{"a":1,}', '']) assert.throws(() => parseStrictJson(bad), { code: 'bad-request' }, bad);
});

test('request key: a duplicate submit, however the members are ordered, concurrent or after a restart, sends nothing new', async t => {
  const w = world(t);
  const s = w.boot();
  const reordered = Object.fromEntries(Object.entries(intent()).reverse());
  const results = await Promise.all([s.submit(PRINCIPAL, 'click-1', intent()), s.submit(PRINCIPAL, 'click-1', reordered), s.submit(PRINCIPAL, 'click-1', JSON.stringify(intent()))]);
  assert.equal(new Set(results.map(r => r.request.mutationId)).size, 1);
  assert.deepEqual(results.map(r => r.state), ['confirmed', 'confirmed', 'confirmed']);
  const again = await s.submit(PRINCIPAL, 'click-1', intent());
  const restarted = await w.boot().submit(PRINCIPAL, 'click-1', intent());
  assert.equal(again.request.mutationId, results[0].request.mutationId);
  assert.equal(restarted.request.mutationId, results[0].request.mutationId);
  assert.equal(w.count('control-worker'), 1);
  assert.equal(w.daemon().effects['browser-stop'], 1);
  assert.equal(w.boot().store.list().length, 1);
});

test('request key: after a lost reply a duplicate shows unknown and never resends; only a new key is a fresh action', async t => {
  const w = world(t);
  w.flag('drop-reply');
  const s = w.boot();
  const first = await s.submit(PRINCIPAL, 'click-1', intent());
  assert.equal(first.state, 'unknown');
  const dup = await w.boot().submit(PRINCIPAL, 'click-1', intent());
  assert.deepEqual({ state: dup.state, id: dup.request.mutationId }, { state: 'unknown', id: first.request.mutationId });
  assert.equal(w.count('control-worker'), 1);
  const fresh = await w.boot().submit(PRINCIPAL, 'click-2', intent());
  assert.notEqual(fresh.request.mutationId, first.request.mutationId);
  assert.equal(w.count('control-worker'), 2, 'a new key is an explicit new action');
});

test('request key: reuse for a different intent conflicts, keys are scoped per principal and project, bad keys are bad-request', async t => {
  const w = world(t);
  w.enrollment.grant('write-2', { principal: 'second-principal', projectId: 'fixture-project', mode: 'mutate' });
  const s = w.boot();
  const first = await s.submit(PRINCIPAL, 'click-1', intent());
  const clash = await s.submit(PRINCIPAL, 'click-1', intent({ operation: 'restart' }));
  assert.deepEqual({ state: clash.state, source: clash.source, code: clash.error.code }, { state: 'refused', source: 'admission', code: 'request-key-conflict' });
  assert.equal(w.count('control-worker'), 1);
  const other = await s.submit('second-principal', 'click-1', intent({ operation: 'restart' }));
  assert.notEqual(other.request.mutationId, first.request.mutationId, 'another principal has its own key space');
  const calls = w.calls().length;
  for (const key of ['', 'k'.repeat(201), 7, null, undefined]) {
    const r = await s.submit(PRINCIPAL, key, intent());
    assert.deepEqual([Object.keys(r), r.error.code], [['error'], 'bad-request'], String(key));
  }
  assert.equal(w.calls().length, calls);
});

test('request key: a refusal before any intent existed does not burn the key, and a duplicate needs the read grant', async t => {
  const w = world(t);
  const s = w.boot();
  assert.equal((await s.submit('late-principal', 'click-1', intent())).error.code, 'grant-denied');
  w.enrollment.grant('write-late', { principal: 'late-principal', projectId: 'fixture-project', mode: 'mutate' });
  w.enrollment.grant('read-late', { principal: 'late-principal', projectId: 'fixture-project', mode: 'read' });
  const ok = await s.submit('late-principal', 'click-1', intent());
  assert.equal(ok.state, 'confirmed');
  w.enrollment.revoke('read-late');
  const denied = await s.submit('late-principal', 'click-1', intent());
  assert.deepEqual({ state: denied.state, source: denied.source, request: denied.request }, { state: 'refused', source: 'admission', request: null });
  assert.equal(w.count('control-worker'), 1);
});

test('request key: concurrent duplicates of a refused submission get that refusal and the key stays reusable', async t => {
  const w = world(t);
  const s = w.boot();
  const both = await Promise.all([s.submit('late-principal', 'click-1', intent()), s.submit('late-principal', 'click-1', intent())]);
  assert.deepEqual(both.map(r => r.error.code), ['grant-denied', 'grant-denied']);
  assert.equal(s.store.list().length, 0);
  w.enrollment.grant('write-late', { principal: 'late-principal', projectId: 'fixture-project', mode: 'mutate' });
  assert.equal((await s.submit('late-principal', 'click-1', intent())).state, 'confirmed');
  assert.equal(w.count('control-worker'), 1);
});

test('request key: a persisted sending record from a crashed supervisor is a duplicate, not a second dispatch', async t => {
  const w = world(t);
  const crashing = { call: async body => (body.operation === 'control-worker' ? new Promise(() => {}) : w.door.call(body, {})) };
  void w.boot({ doors: () => crashing }).submit(PRINCIPAL, 'click-1', intent());
  await new Promise(r => setTimeout(r, 400));
  const dup = await w.boot().submit(PRINCIPAL, 'click-1', intent());
  assert.deepEqual({ state: dup.state, source: dup.source }, { state: 'unknown', source: 'transport' });
  assert.equal(w.count('control-worker'), 0, 'the duplicate dispatched nothing');
  assert.equal(w.boot().store.list().length, 1);
});
