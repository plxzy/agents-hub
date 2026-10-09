import test from 'node:test';
import assert from 'node:assert/strict';
import { GrantAuthority, DEVELOPMENT } from './dev-grants.mjs';
function fixture() {
  let now = 1000, boot = 'process-00000001';
  const data = new Map();
  const store = { get: id => structuredClone(data.get(id)), put: (id, r) => data.set(id, structuredClone(r)), list: () => [...data.values()].map(r => structuredClone(r)) };
  const a = new GrantAuthority(store, { now: () => now, processSession: () => boot });
  const manifest = { host: 'dok-dev', project: 'dev-workflow', agent: 'workflow', conversation_id: 'conversation-0001', workspace_id: 'workspace-0001',
    implementation_revision: 'implementation-01', knowledge_revision: 'knowledge-0001', policy_digest: 'policy-00000001', process_session: boot };
  const g = a.request('owner', 'request-0001', 'input-1', manifest);
  return { a, g, store, manifest, advance: ms => now += ms, reboot: () => boot = 'process-00000002' };
}
test('grant approval is owner-bound, one-use, private and immutable', async () => {
  const { a, g, store } = fixture();
  await assert.rejects(a.decide('owner', g.grant_id, 'approve', 'forged'));
  assert.throws(() => a.get('other', g.grant_id));
  const token = await a.issue('owner', g.grant_id, 'approve');
  assert.ok(!JSON.stringify(a.list('owner')).includes(token));
  assert.ok(!JSON.stringify(a.get('owner', g.grant_id)).includes('challenge'));
  await a.decide('owner', g.grant_id, 'approve', token);
  await assert.rejects(a.decide('owner', g.grant_id, 'approve', token));
  assert.throws(() => a.authorize('owner', g.grant_id, 'another-conversation'));
  assert.equal(a.authorize('owner', g.grant_id, g.manifest.conversation_id).status, 'active');
  assert.equal(store.get(g.grant_id).challenge, undefined);
});
test('card scope changes invalidate approval and duplicate input cannot change meaning', async () => {
  const { a, g, store, manifest } = fixture();
  const token = await a.issue('owner', g.grant_id, 'approve');
  const r = store.get(g.grant_id); r.manifest.policy_digest = 'changed-policy-000'; store.put(g.grant_id, r);
  await assert.rejects(a.decide('owner', g.grant_id, 'approve', token));
  assert.throws(() => a.request('owner', 'request-0001', 'changed-input', manifest));
});
test('expiry, revocation while disconnected and supervisor restart deny leases', async () => {
  const f = fixture(), { a, g } = f;
  await a.decide('owner', g.grant_id, 'approve', await a.issue('owner', g.grant_id, 'approve'));
  const lease = { grant_id: g.grant_id, process_session: g.manifest.process_session, policy_digest: g.manifest.policy_digest };
  assert.equal(a.lease(lease).lease_ms, DEVELOPMENT.leaseMs);
  const revoked = await a.decide('owner', g.grant_id, 'revoke', await a.issue('owner', g.grant_id, 'revoke'));
  assert.equal(revoked.execution_confirmed_stopped, false);
  assert.equal(a.lease(lease).authorized, false);
  a.lease({ ...lease, execution_state: 'stopped' });
  assert.equal(a.get('owner', g.grant_id).execution_confirmed_stopped, true);
  const f2 = fixture(); f2.advance(DEVELOPMENT.challengeMs + 1);
  const code = await f2.a.issue('owner', f2.g.grant_id, 'approve'); f2.reboot();
  await assert.rejects(f2.a.decide('owner', f2.g.grant_id, 'approve', code), /restarted/);
  const f3 = fixture();
  await f3.a.decide('owner', f3.g.grant_id, 'approve', await f3.a.issue('owner', f3.g.grant_id, 'approve'));
  f3.advance(DEVELOPMENT.grantMs);
  assert.equal(f3.a.lease({ ...lease, grant_id: f3.g.grant_id }).authorized, false);
});
