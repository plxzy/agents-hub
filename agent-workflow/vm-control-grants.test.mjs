// VM-project enrollment and grant provider (plxzy/vm#806). Temp dirs and an injected clock only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, VmProjectGrants } from './vm-control-grants.mjs';

const OWNER = 'owner-1';
const SPEC = { hostId: 'host-a', service: 'service-a', doorRef: 'door-a', workers: ['container'], targets: ['backing', 'browser'], operations: ['start', 'stop', 'restart'] };
const INTENT = { projectId: 'project-a', hostId: 'host-a', service: 'service-a', worker: 'container', target: 'browser', operation: 'stop' };
const ask = { principal: 'p-1', mode: 'mutate' };

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-grants-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: 5_000_000, now: () => clock.t };
  const make = () => new VmProjectGrants({ dir, owners: [OWNER], now: clock.now, ...options });
  const grants = make();
  grants.enroll(OWNER, 'project-a', SPEC);
  const approve = (g, spec, requestId = 'request-' + Math.random().toString(36).slice(2, 10)) => {
    const pending = g.request(spec.principal ?? ask.principal, requestId, { projectId: 'project-a', mode: 'mutate', ...spec.scope });
    return g.decide(OWNER, pending.grant_id, 'approve', g.issue(OWNER, pending.grant_id, 'approve'));
  };
  return { dir, clock, grants, make, approve };
}
const verdict = (g, over = {}) => g.evaluate({ principal: 'p-1', mode: 'mutate', intent: { ...INTENT, ...over.intent }, ...over.top });

test('deny by default: no enrollment, a pending grant, and the wrong principal or mode all deny', t => {
  const { grants, approve } = fixture(t);
  const pending = grants.request('p-1', 'request-pending', { projectId: 'project-a', mode: 'mutate' });
  assert.equal(pending.status, 'pending');
  assert.equal(verdict(grants).ok, false, 'a pending grant authorizes nothing');
  assert.deepEqual(verdict(grants, { intent: { projectId: 'unenrolled' } }), { ok: false, code: 'grant-denied', detail: 'no enrollment for this project' });
  approve(grants, { scope: {} }, 'request-approved');
  assert.equal(verdict(grants).ok, true);
  assert.equal(verdict(grants, { top: { principal: 'someone-else' } }).ok, false);
  assert.equal(verdict(grants, { top: { mode: 'read' } }).code, 'grant-denied', 'a mutate grant is not a read grant');
});

test('an approved grant returns the enrolled door reference and pins', t => {
  const { grants, approve } = fixture(t);
  approve(grants, {});
  assert.deepEqual(verdict(grants), { ok: true, doorRef: 'door-a', hostId: 'host-a', service: 'service-a' });
});

test('scope: worker, target and operation outside the grant are denied; a narrower grant stays narrow', t => {
  const { grants, approve } = fixture(t);
  approve(grants, { scope: { targets: ['browser'], operations: ['stop'] } });
  assert.equal(verdict(grants).ok, true);
  for (const intent of [{ target: 'backing' }, { operation: 'start' }, { operation: 'restart' }, { worker: 'other-worker' }]) {
    assert.deepEqual(verdict(grants, { intent }), { ok: false, code: 'grant-denied', detail: 'no active mutate grant for this scope' }, JSON.stringify(intent));
  }
});

test('a grant cannot exceed its enrollment and a request must name an active enrollment', t => {
  const { grants } = fixture(t);
  assert.throws(() => grants.request('p-1', 'request-wide-1', { projectId: 'project-a', mode: 'mutate', workers: ['container', 'other'] }), /exceeds the enrollment/);
  assert.throws(() => grants.request('p-1', 'request-wide-2', { projectId: 'project-a', mode: 'mutate', targets: ['host'] }), /Invalid targets/);
  assert.throws(() => grants.request('p-1', 'request-none-1', { projectId: 'unenrolled', mode: 'mutate' }), /No active enrollment/);
  assert.throws(() => grants.request('p-1', 'request-mode-1', { projectId: 'project-a', mode: 'admin' }), /Invalid grant scope/);
  assert.throws(() => grants.request('p-1', 'request-extra1', { projectId: 'project-a', mode: 'mutate', path: '/tmp' }), /Invalid scope members/);
  assert.throws(() => grants.request('p-1', 'short', { projectId: 'project-a', mode: 'mutate' }), /Invalid request identity/);
});

test('host and service pins come from the enrollment, not the caller', t => {
  const { grants, approve } = fixture(t);
  approve(grants, {});
  for (const intent of [{ hostId: 'another-host' }, { service: 'another-service' }]) {
    assert.deepEqual(verdict(grants, { intent }), { ok: false, code: 'identity-mismatch', detail: 'host or service does not match the enrollment' });
  }
});

test('expiry: a grant stops authorizing at expires_at, ttl may only shorten it, and a pending grant expires too', t => {
  const { grants, clock, approve } = fixture(t, { grantMs: 60_000 });
  assert.throws(() => grants.request('p-1', 'request-long-1', { projectId: 'project-a', mode: 'mutate', ttlMs: 60_001 }), /Invalid grant lifetime/);
  const short = approve(grants, { scope: { ttlMs: 1000 } }, 'request-short-1');
  const full = approve(grants, { principal: 'p-2' }, 'request-full-1');
  const pending = grants.request('p-3', 'request-pend-1', { projectId: 'project-a', mode: 'mutate' });
  assert.equal(verdict(grants).ok, true);
  clock.t += 1000;
  assert.equal(verdict(grants).ok, false, 'expired exactly at expires_at');
  assert.equal(grants.get(short.grant_id).status, 'expired');
  assert.equal(verdict(grants, { top: { principal: 'p-2' } }).ok, true);
  clock.t += 60_000;
  assert.equal(grants.get(full.grant_id).status, 'expired');
  assert.throws(() => grants.issue(OWNER, pending.grant_id, 'approve'), /Decision no longer available/);
});

test('approval is owner-only, one-use, hashed at rest, bound to the exact manifest and time-limited', t => {
  const { grants, clock, dir } = fixture(t);
  const g = grants.request('p-1', 'request-token-1', { projectId: 'project-a', mode: 'mutate' });
  assert.throws(() => grants.issue('p-1', g.grant_id, 'approve'), /Not an enrollment owner/, 'the requester cannot approve itself');
  const token = grants.issue(OWNER, g.grant_id, 'approve');
  assert.throws(() => grants.decide(OWNER, g.grant_id, 'approve', 'forged'), /Invalid or expired approval/);
  assert.throws(() => grants.decide('p-1', g.grant_id, 'approve', token), /Not an enrollment owner/);
  assert.ok(!JSON.stringify(grants.get(g.grant_id)).includes(token) && !JSON.stringify(grants.listFor('p-1')).includes('challenge'));
  const stored = [...fs.readdirSync(path.join(dir, 'grants'))].map(f => fs.readFileSync(path.join(dir, 'grants', f), 'utf8')).join('');
  assert.ok(!stored.includes(token), 'only the hash is stored');
  assert.equal(grants.decide(OWNER, g.grant_id, 'approve', token).status, 'active');
  assert.throws(() => grants.decide(OWNER, g.grant_id, 'approve', token), /Invalid or expired approval|no longer pending/, 'one use');

  const late = grants.request('p-1', 'request-token-2', { projectId: 'project-a', mode: 'read' });
  const lateToken = grants.issue(OWNER, late.grant_id, 'approve');
  clock.t += DEFAULTS.challengeMs + 1;
  assert.throws(() => grants.decide(OWNER, late.grant_id, 'approve', lateToken), /Invalid or expired approval/);

  const tampered = grants.request('p-1', 'request-token-3', { projectId: 'project-a', mode: 'read' });
  const tamperedToken = grants.issue(OWNER, tampered.grant_id, 'approve');
  const record = grants.grants.get(tampered.grant_id);
  record.scope.workers = ['container', 'injected'];
  grants.grants.put(tampered.grant_id, record);
  assert.throws(() => grants.decide(OWNER, tampered.grant_id, 'approve', tamperedToken), /Invalid or expired approval/, 'a changed manifest voids the approval');
});

test('revoking mutate stops mutations at once while read keeps working; revocation is permanent and works across processes', t => {
  const { grants, make, approve } = fixture(t);
  const write = approve(grants, {}, 'request-write-1');
  approve(grants, { scope: { mode: 'read' } }, 'request-read-1');
  assert.equal(verdict(grants).ok, true);
  assert.equal(verdict(grants, { top: { mode: 'read' } }).ok, true);
  // Another process (owner tooling) revokes; the supervisor's instance has no cache and sees it on the next evaluation.
  const other = make();
  assert.equal(other.decide(OWNER, write.grant_id, 'revoke', other.issue(OWNER, write.grant_id, 'revoke')).status, 'revoked');
  assert.equal(verdict(grants).ok, false);
  assert.equal(verdict(grants, { top: { mode: 'read' } }).ok, true, 'receipt reads have their own grant');
  assert.throws(() => grants.issue(OWNER, write.grant_id, 'approve'), /Decision no longer available/, 'a revoked grant cannot be revived');
  assert.throws(() => grants.issue(OWNER, write.grant_id, 'revoke'), /Decision no longer available/);
});

test('grants are durable across a supervisor restart (no process-session binding): reads survive, expiry still applies', t => {
  const { grants, make, clock, approve } = fixture(t);
  approve(grants, { scope: { mode: 'read' } }, 'request-read-1');
  const restarted = make();
  assert.equal(verdict(restarted, { top: { mode: 'read' } }).ok, true);
  assert.equal(restarted.listFor('p-1').length, 1);
  clock.t += DEFAULTS.grantMs;
  assert.equal(verdict(make(), { top: { mode: 'read' } }).ok, false);
});

test('changing or withdrawing the enrollment invalidates old grants; a new revision needs new approval', t => {
  const { grants, approve } = fixture(t);
  const g = approve(grants, {}, 'request-rev-1');
  assert.equal(grants.enroll(OWNER, 'project-a', { ...SPEC, workers: ['container'] }).revision, 1, 'an identical enrollment is a no-op');
  assert.equal(verdict(grants).ok, true);
  assert.equal(grants.enroll(OWNER, 'project-a', { ...SPEC, service: 'service-b' }).revision, 2);
  assert.equal(verdict(grants, { intent: { service: 'service-b' } }).ok, false, 'the old grant does not carry over to the new binding');
  assert.equal(grants.get(g.grant_id).status, 'invalidated');
  approve(grants, {}, 'request-rev-2');
  assert.equal(verdict(grants, { intent: { service: 'service-b' } }).ok, true);
  grants.withdraw(OWNER, 'project-a');
  assert.equal(verdict(grants, { intent: { service: 'service-b' } }).code, 'grant-denied');
  assert.throws(() => grants.request('p-1', 'request-rev-3', { projectId: 'project-a', mode: 'mutate' }), /No active enrollment/);
  grants.enroll(OWNER, 'project-a', { ...SPEC, service: 'service-b' });
  assert.equal(verdict(grants, { intent: { service: 'service-b' } }).ok, false, 're-enrolling does not revive earlier grants');
});

test('a pending approval is voided if the enrollment changes before the click', t => {
  const { grants } = fixture(t);
  const g = grants.request('p-1', 'request-void-1', { projectId: 'project-a', mode: 'mutate' });
  const token = grants.issue(OWNER, g.grant_id, 'approve');
  grants.enroll(OWNER, 'project-a', { ...SPEC, doorRef: 'door-b' });
  assert.throws(() => grants.decide(OWNER, g.grant_id, 'approve', token), /Grant no longer pending/);
});

test('enrollment is owner-only and strictly validated: no paths, no unknown members, only the closed targets and operations', t => {
  const { grants } = fixture(t);
  assert.throws(() => grants.enroll('p-1', 'project-b', SPEC), /Not an enrollment owner/);
  const bad = {
    'path as door': { ...SPEC, doorRef: '/usr/local/bin/helper' }, 'dotted path': { ...SPEC, doorRef: '../door' }, 'long door': { ...SPEC, doorRef: 'd'.repeat(65) },
    'extra command': { ...SPEC, command: 'docker rm' }, 'missing host': (({ hostId, ...r }) => r)(SPEC), 'unknown target': { ...SPEC, targets: ['host'] },
    'unknown operation': { ...SPEC, operations: ['delete'] }, 'empty workers': { ...SPEC, workers: [] }, 'non-string worker': { ...SPEC, workers: [7] },
    'array spec': [], 'empty id': { ...SPEC, service: '' },
  };
  for (const [name, spec] of Object.entries(bad)) assert.throws(() => grants.enroll(OWNER, 'project-b', spec), /Invalid/, name);
  assert.throws(() => grants.enroll(OWNER, '', SPEC), /Invalid project/);
  assert.equal(grants.enrollment('project-b'), undefined);
  assert.throws(() => new VmProjectGrants({ dir: os.tmpdir(), owners: [] }), /owner/);
});

test('request ids are idempotent for the same request and conflict for a different one', t => {
  const { grants } = fixture(t);
  const a = grants.request('p-1', 'request-same-1', { projectId: 'project-a', mode: 'mutate', targets: ['browser'] });
  const b = grants.request('p-1', 'request-same-1', { projectId: 'project-a', mode: 'mutate', targets: ['browser'] });
  assert.equal(a.grant_id, b.grant_id);
  assert.equal(grants.listFor('p-1').length, 1);
  assert.throws(() => grants.request('p-1', 'request-same-1', { projectId: 'project-a', mode: 'mutate' }), /Request ID conflict/);
  assert.throws(() => grants.request('p-2', 'request-same-1', { projectId: 'project-a', mode: 'mutate', targets: ['browser'] }), /Request ID conflict/);
});
