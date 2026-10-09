// Shared grant authority. The Worker supplies durable, synchronous storage.
// Approval credentials are returned separately from all model-visible data.
export const DEVELOPMENT = Object.freeze({ host: 'dok-dev', project: 'dev-workflow', agent: 'workflow',
  grantMs: 4 * 60 * 60 * 1000, leaseMs: 60000, renewMs: 20000, challengeMs: 300000 });
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export async function digest(value) {
  const data = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(canonical(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}
export function validManifest(m) {
  if (!m || m.host !== DEVELOPMENT.host || m.project !== DEVELOPMENT.project || m.agent !== DEVELOPMENT.agent) throw new Error('Unsupported development scope');
  for (const k of ['conversation_id', 'workspace_id', 'implementation_revision', 'knowledge_revision', 'policy_digest', 'process_session']) {
    if (typeof m[k] !== 'string' || !/^[a-zA-Z0-9_.-]{8,128}$/.test(m[k])) throw new Error('Invalid manifest ' + k);
  }
  return Object.fromEntries(['host', 'project', 'agent', 'conversation_id', 'workspace_id', 'implementation_revision',
    'knowledge_revision', 'policy_digest', 'process_session'].map(k => [k, m[k]]));
}
export class GrantAuthority {
  constructor(store, { now = Date.now, processSession = () => null } = {}) { this.store = store; this.now = now; this.processSession = processSession; }
  own(id, owner) {
    const r = this.store.get(id);
    if (!owner || !r || r.owner !== owner) throw new Error('Unknown development grant');
    return r;
  }
  public(r) {
    const { owner, challenge, revoke_challenge, request_fingerprint, ...safe } = r;
    return { ...safe, status: r.status === 'active' && r.expires_at <= this.now() ? 'expired' : r.status,
      execution_confirmed_stopped: r.execution_state === 'stopped',
      permissions: ['read', 'edit', 'test', 'local commit', 'export review branch'],
      network: 'sandbox loopback only; inference uses the selected provider' };
  }
  request(owner, requestId, fingerprint, manifest) {
    if (!owner || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw new Error('Invalid request identity');
    const previous = this.store.list().find(r => r.request_id === requestId);
    if (previous) {
      if (previous.owner !== owner || previous.request_fingerprint !== fingerprint) throw new Error('Request ID conflict');
      return this.public(previous);
    }
    const scope = validManifest(manifest);
    if (scope.process_session !== this.processSession()) throw new Error('Host restarted; request a new grant');
    const r = { grant_id: crypto.randomUUID(), request_id: requestId, request_fingerprint: fingerprint, owner,
      manifest: scope, status: 'pending', created_at: this.now(), expires_at: this.now() + DEVELOPMENT.grantMs,
      execution_state: 'stopped', last_observed_at: this.now() };
    this.store.put(r.grant_id, r);
    return this.public(r);
  }
  get(owner, id) { return this.public(this.own(id, owner)); }
  list(owner) { return this.store.list().filter(r => r.owner === owner).map(r => this.public(r)); }
  async issue(owner, id, kind) {
    if (!['approve', 'revoke'].includes(kind)) throw new Error('Invalid decision');
    const r = this.own(id, owner);
    if (kind === 'approve' && r.status !== 'pending' || kind === 'revoke' && r.status !== 'active') throw new Error('Decision no longer available');
    const token = crypto.randomUUID() + crypto.randomUUID();
    const hash = await digest(token), binding = await digest({ manifest: r.manifest, expires_at: r.expires_at });
    const current = this.own(id, owner);
    if (current.status !== r.status) throw new Error('Decision changed; refresh');
    current[kind === 'approve' ? 'challenge' : 'revoke_challenge'] = { hash, binding, expires: this.now() + DEVELOPMENT.challengeMs };
    this.store.put(id, current);
    return token;
  }
  async decide(owner, id, kind, token) {
    if (!['approve', 'revoke'].includes(kind) || typeof token !== 'string' || token.length > 100) throw new Error('User click required');
    const hash = await digest(token);
    const r = this.own(id, owner), key = kind === 'approve' ? 'challenge' : 'revoke_challenge', c = r[key];
    const binding = await digest({ manifest: r.manifest, expires_at: r.expires_at });
    // Re-read after hashing so concurrent clicks cannot redeem twice.
    const current = this.own(id, owner);
    if (!c || current[key]?.hash !== c.hash || c.hash !== hash || c.expires <= this.now() || c.binding !== binding
      || JSON.stringify(current.manifest) !== JSON.stringify(r.manifest) || current.expires_at !== r.expires_at) throw new Error('Invalid or expired approval; refresh the panel');
    if (kind === 'approve') {
      if (current.status !== 'pending' || current.expires_at <= this.now()) throw new Error('Grant no longer pending');
      if (current.manifest.process_session !== this.processSession()) throw new Error('Host restarted; request a new grant');
      current.status = 'active'; current.approved_at = this.now();
    } else {
      if (current.status !== 'active') throw new Error('Grant is not active');
      current.status = 'revoked'; current.revoked_at = this.now();
    }
    delete current[key]; this.store.put(id, current);
    return this.public(current);
  }
  authorize(owner, id, conversationId) {
    const r = this.own(id, owner);
    if (r.status !== 'active' || r.expires_at <= this.now()) throw new Error('Development grant is not active');
    if (r.manifest.process_session !== this.processSession()) throw new Error('Supervisor restarted; new approval required');
    if (r.manifest.conversation_id !== conversationId) throw new Error('Conversation does not match grant');
    return this.public(r);
  }
  lease({ grant_id, process_session, policy_digest, execution_state }) {
    const r = this.store.get(grant_id);
    if (!r || r.manifest.process_session !== process_session || r.manifest.policy_digest !== policy_digest) throw new Error('Lease scope mismatch');
    if (execution_state === 'stopped') {
      r.execution_state = 'stopped'; r.last_observed_at = this.now(); this.store.put(grant_id, r);
      return { authorized: false, stopped: true };
    }
    if (r.status !== 'active' || r.expires_at <= this.now() || process_session !== this.processSession()) return { authorized: false, lease_ms: 0 };
    const lease_ms = Math.min(DEVELOPMENT.leaseMs, r.expires_at - this.now());
    r.execution_state = 'running'; r.last_observed_at = this.now(); r.lease_until = this.now() + lease_ms;
    this.store.put(grant_id, r);
    return { authorized: true, lease_ms, grant_id, policy_digest };
  }
}
