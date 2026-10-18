// VM-project enrollment and grants (plxzy/vm#806; contract: vm docs/AGENTS-HUB-VMSERVICE-CONTRACT.md, "Separate VM-project
// enrollment and grant"). An owner provisions an ENROLLMENT binding a trusted projectId to a host, the expected service pin,
// a fixed door reference and the allowed workers, targets and operations. A separate, revocable, expiring GRANT authorizes a
// principal for one project in one mode ('mutate' or 'read') within that scope. Deny by default: absent, pending, expired,
// revoked, invalidated or mismatched all deny. Receipt reads need their own read grant and never fall back to a mutate grant.
//
// This adapts dev-grants.mjs (owner-approved, one-use challenge tokens, click-only decisions, bound to the exact manifest),
// with three deliberate differences:
//  - Grants are NOT bound to a supervisor process session. The contract needs bounded receipt polls to survive a supervisor
//    restart, so grants are durable and expire by clock instead.
//  - Enrollment and grants are separate records; a grant is pinned to the enrollment revision it was approved against, so
//    changing the trusted binding (or withdrawing it) invalidates old routes without touching any receipt identity.
//  - Mutate and read are separate grants.
// Everything is synchronous and re-read from disk on every decision: there is no cache, so a revocation written by another
// process takes effect on the next evaluation. One writer per directory is assumed (no cross-process locking).
// The enrollment holds a door REFERENCE only, never a credential, path or command.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical } from './dev-grants.mjs';
import { read, save } from './durable-file.mjs';

export const DEFAULTS = Object.freeze({ grantMs: 4 * 60 * 60 * 1000, challengeMs: 5 * 60 * 1000 });
const TARGETS = ['backing', 'browser'], OPERATIONS = ['start', 'stop', 'restart'], MODES = ['mutate', 'read'];
const DOOR_REF = /^[A-Za-z0-9_.-]{1,64}$/, REQUEST_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const isId = v => typeof v === 'string' && v.length >= 1 && v.length <= 200;
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exactKeys = (v, required, optional = []) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid scope');
  if (required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new Error('Invalid scope members');
};
const list = (v, name, allowed) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > 64 || v.some(x => allowed ? !allowed.includes(x) : !isId(x))) throw new Error(`Invalid ${name}`);
  return [...new Set(v)].sort();
};

/** One atomic file per record, named by the hash of its id (ids are caller-controlled and never become paths). */
export class FileRecordStore {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  #file(id) { return path.join(this.dir, sha(id) + '.json'); }
  get(id) { try { return read(this.#file(id)).record; } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
  put(id, record) { save(this.#file(id), { id, record }); }
  list() { return fs.readdirSync(this.dir).filter(f => /^[0-9a-f]{64}\.json$/.test(f)).sort().map(f => read(path.join(this.dir, f)).record); }
}

export class VmProjectGrants {
  /** `owners` are the trusted principals allowed to provision enrollments and decide grants; the host authenticates them. */
  constructor({ dir, owners, now = Date.now, grantMs = DEFAULTS.grantMs, challengeMs = DEFAULTS.challengeMs }) {
    if (!Array.isArray(owners) || owners.length < 1 || !owners.every(isId)) throw new Error('At least one owner is required');
    this.owners = new Set(owners); this.now = now; this.grantMs = grantMs; this.challengeMs = challengeMs;
    this.enrollments = new FileRecordStore(path.join(dir, 'enrollments'));
    this.grants = new FileRecordStore(path.join(dir, 'grants'));
  }
  #owner(owner) { if (!this.owners.has(owner)) throw new Error('Not an enrollment owner'); }

  // ---- enrollment (owner only)
  /** Create or replace the enrollment for a project. A change bumps `revision`, which invalidates every grant approved
   *  against the old one; re-enrolling an identical active enrollment is a no-op. */
  enroll(owner, projectId, spec) {
    this.#owner(owner);
    if (!isId(projectId)) throw new Error('Invalid project');
    exactKeys(spec, ['hostId', 'service', 'doorRef', 'workers', 'targets', 'operations']);
    if (!isId(spec.hostId) || !isId(spec.service) || typeof spec.doorRef !== 'string' || !DOOR_REF.test(spec.doorRef)) throw new Error('Invalid enrollment identity');
    const scope = { hostId: spec.hostId, service: spec.service, doorRef: spec.doorRef, workers: list(spec.workers, 'workers'),
      targets: list(spec.targets, 'targets', TARGETS), operations: list(spec.operations, 'operations', OPERATIONS) };
    const previous = this.enrollments.get(projectId);
    if (previous?.status === 'active' && sha(scopeOf(previous)) === sha(scope)) return structuredClone(previous);
    const record = { projectId, ...scope, status: 'active', revision: (previous?.revision ?? 0) + 1, created_at: previous?.created_at ?? this.now(), updated_at: this.now() };
    this.enrollments.put(projectId, record);
    return structuredClone(record);
  }
  /** Withdraw an enrollment: every grant for it stops authorizing, and re-enrolling later starts a new revision. */
  withdraw(owner, projectId) {
    this.#owner(owner);
    const previous = this.enrollments.get(projectId);
    if (!previous || previous.status !== 'active') throw new Error('No active enrollment');
    const record = { ...previous, status: 'withdrawn', revision: previous.revision + 1, updated_at: this.now() };
    this.enrollments.put(projectId, record);
    return structuredClone(record);
  }
  enrollment(projectId) { const e = this.enrollments.get(projectId); return e && structuredClone(e); }

  // ---- grants
  #grant(id) { const r = typeof id === 'string' ? this.grants.get(id) : undefined; if (!r) throw new Error('Unknown grant'); return r; }
  #state(r) {
    if (r.status === 'revoked') return 'revoked';
    if (r.expires_at <= this.now()) return 'expired';
    const e = this.enrollments.get(r.projectId);
    if (!e || e.status !== 'active' || e.revision !== r.enrollment_revision) return 'invalidated';
    return r.status;
  }
  public(r) {
    const { challenge, revoke_challenge, fingerprint, ...safe } = r;
    return { ...structuredClone(safe), status: this.#state(r) };
  }
  get(grantId) { return this.public(this.#grant(grantId)); }
  listFor(principal) { return this.grants.list().filter(r => r.principal === principal).map(r => this.public(r)); }
  #manifest(r) { return sha({ principal: r.principal, projectId: r.projectId, mode: r.mode, scope: r.scope, enrollment_revision: r.enrollment_revision, expires_at: r.expires_at }); }

  /** A principal asks for a grant; it authorizes nothing until an owner approves it. `ttlMs` may only shorten the lifetime.
   *  The same requestId with the same request returns the same grant; with a different one it conflicts. */
  request(principal, requestId, spec) {
    if (!isId(principal) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error('Invalid request identity');
    exactKeys(spec, ['projectId', 'mode'], ['ttlMs', 'workers', 'targets', 'operations']);
    if (!isId(spec.projectId) || !MODES.includes(spec.mode)) throw new Error('Invalid grant scope');
    if (spec.ttlMs !== undefined && (!Number.isSafeInteger(spec.ttlMs) || spec.ttlMs < 1 || spec.ttlMs > this.grantMs)) throw new Error('Invalid grant lifetime');
    const asked = { projectId: spec.projectId, mode: spec.mode, ...(spec.ttlMs === undefined ? {} : { ttlMs: spec.ttlMs }),
      ...(spec.workers === undefined ? {} : { workers: list(spec.workers, 'workers') }),
      ...(spec.targets === undefined ? {} : { targets: list(spec.targets, 'targets', TARGETS) }),
      ...(spec.operations === undefined ? {} : { operations: list(spec.operations, 'operations', OPERATIONS) }) };
    const fingerprint = sha({ principal, asked });
    const previous = this.grants.list().find(r => r.request_id === requestId);
    if (previous) {
      if (previous.principal !== principal || previous.fingerprint !== fingerprint) throw new Error('Request ID conflict');
      return this.public(previous);
    }
    const e = this.enrollments.get(asked.projectId);
    if (!e || e.status !== 'active') throw new Error('No active enrollment');
    const scope = { workers: asked.workers ?? e.workers, targets: asked.targets ?? e.targets, operations: asked.operations ?? e.operations };
    for (const k of Object.keys(scope)) if (!scope[k].every(v => e[k].includes(v))) throw new Error('Grant scope exceeds the enrollment');
    const record = { grant_id: randomUUID(), request_id: requestId, fingerprint, principal, projectId: asked.projectId, mode: asked.mode, scope,
      enrollment_revision: e.revision, status: 'pending', created_at: this.now(), expires_at: this.now() + (asked.ttlMs ?? this.grantMs) };
    this.grants.put(record.grant_id, record);
    return this.public(record);
  }
  /** Step 1 of an owner decision: a one-use token, bound to this exact grant manifest. Returned only to the deciding
   *  owner's channel; it is never part of any public view, and only its hash is stored. */
  issue(owner, grantId, kind) {
    this.#owner(owner);
    if (!['approve', 'revoke'].includes(kind)) throw new Error('Invalid decision');
    const r = this.#grant(grantId), state = this.#state(r);
    if (kind === 'approve' && state !== 'pending' || kind === 'revoke' && state !== 'active') throw new Error('Decision no longer available');
    const token = randomUUID() + randomUUID();
    r[kind === 'approve' ? 'challenge' : 'revoke_challenge'] = { hash: sha(token), binding: this.#manifest(r), owner, expires: this.now() + this.challengeMs };
    this.grants.put(grantId, r);
    return token;
  }
  /** Step 2: redeem the token (a live user click in the owner's UI). Approve activates; revoke stops mutations at once. */
  decide(owner, grantId, kind, token) {
    this.#owner(owner);
    if (!['approve', 'revoke'].includes(kind) || typeof token !== 'string' || token.length > 100) throw new Error('User click required');
    const r = this.#grant(grantId), key = kind === 'approve' ? 'challenge' : 'revoke_challenge', c = r[key], state = this.#state(r);
    if (!c || c.owner !== owner || !sameHash(c.hash, sha(token)) || c.expires <= this.now() || c.binding !== this.#manifest(r)) throw new Error('Invalid or expired approval; refresh the panel');
    if (kind === 'approve') {
      if (state !== 'pending') throw new Error('Grant no longer pending');
      r.status = 'active'; r.approved_at = this.now(); r.approved_by = owner;
    } else {
      if (state !== 'active') throw new Error('Grant is not active');
      r.status = 'revoked'; r.revoked_at = this.now(); r.revoked_by = owner;
    }
    delete r[key];
    this.grants.put(grantId, r);
    return this.public(r);
  }

  /** The supervisor's gate: {ok, doorRef, hostId, service} or {ok:false, code, detail}. Never throws on a denial. */
  evaluate({ principal, mode, intent }) {
    const denied = detail => ({ ok: false, code: 'grant-denied', detail });
    const e = this.enrollments.get(intent.projectId);
    if (!e || e.status !== 'active') return denied('no enrollment for this project');
    const grant = this.grants.list().find(r => r.principal === principal && r.projectId === intent.projectId && r.mode === mode && this.#state(r) === 'active'
      && r.scope.workers.includes(intent.worker) && r.scope.targets.includes(intent.target) && r.scope.operations.includes(intent.operation));
    if (!grant) return denied(`no active ${mode} grant for this scope`);
    if (!e.workers.includes(intent.worker) || !e.targets.includes(intent.target) || !e.operations.includes(intent.operation)) return denied('outside the enrolled scope');
    if (intent.hostId !== e.hostId || intent.service !== e.service) return { ok: false, code: 'identity-mismatch', detail: 'host or service does not match the enrollment' };
    return { ok: true, doorRef: e.doorRef, hostId: e.hostId, service: e.service };
  }
}
const scopeOf = ({ hostId, service, doorRef, workers, targets, operations }) => ({ hostId, service, doorRef, workers, targets, operations });
