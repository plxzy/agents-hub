// Agents Hub's read-only view of supervisor-owned VM control intents (plxzy/vm#806).
// It reads the supervisor's persisted intent through a read-only handle and shows the service's evidence with its
// provenance and freshness. It owns no worker, job, history, dedupe or restart policy, holds no credential, opens no
// listener, tunnel or MCP endpoint, and never writes. Same-process or by file read only.
import { actionFor } from './vm-control-contract.mjs';

const LABELS = Object.freeze({
  'backing:start': 'VM backing start', 'backing:stop': 'VM backing stop',
  'browser:start': 'Browser resume (not a backing start)', 'browser:stop': 'Browser stop (not a backing stop)',
  'browser:restart': 'Browser restart (not a VM/backing restart)',
});
export const STALE_AFTER_MS = 5 * 60 * 1000;
const evidenceView = (e, now) => e && { state: e.state, source: e.source, via: e.via, observedAt: e.at, ageMs: Math.max(0, now - e.at), reply: e.reply, error: e.error };

/** One intent as the Hub displays it. `liveEpoch` is the running supervisor's epoch: a `sending` record from another
 *  epoch is shown unknown (the supervisor crashed before recording a reply), never pending and never retryable. */
export function projectIntent(record, { now = Date.now(), liveEpoch = null, staleAfterMs = STALE_AFTER_MS } = {}) {
  const { request } = record;
  const key = `${request.target}:${request.operation}`;
  if (!LABELS[key]) throw new Error('intent is outside the closed action table');
  const lostReply = record.phase === 'sending' && record.epoch !== liveEpoch;
  const pending = record.phase === 'sending' && !lostReply && !record.latest;
  const current = record.settled ?? (lostReply && !record.latest ? { state: 'unknown', source: 'transport', via: 'recovery', at: record.updatedAt ?? record.createdAt,
    reply: null, error: { code: 'reply-unavailable', detail: 'supervisor restarted before a reply was recorded' } } : record.latest);
  const state = pending ? 'pending' : current.state;
  const observedAt = current?.at ?? record.createdAt;
  const settled = !!record.settled;
  const historical = !settled && record.evidence && record.evidence !== record.latest ? evidenceView(record.evidence, now) : null;
  return {
    format: 1,
    label: LABELS[key],
    target: request.target,
    operation: request.operation,
    action: actionFor(request.target, request.operation),
    tuple: { hostId: request.hostId, service: request.service, projectId: request.projectId, worker: request.worker,
      workerGeneration: request.workerGeneration, backingId: request.backingId, mutationId: request.mutationId },
    state,
    provenance: { origin: pending ? 'supervisor-intent' : current.source, via: pending ? 'control' : current.via, settledByService: settled },
    freshness: { observedAt, ageMs: Math.max(0, now - observedAt), stale: !settled && now - observedAt > staleAfterMs },
    evidence: pending ? null : { reply: current.reply, error: current.error },
    historicalEvidence: historical,
    latestAttempt: record.latest && record.settled && record.latest !== record.settled ? evidenceView(record.latest, now) : null,
    polling: { attempts: record.poll.attempts, exhausted: record.poll.exhausted, active: !!record.poll.active },
    note: state === 'confirmed' ? 'Receipt confirmation is not current worker health.' : undefined,
  };
}

/** Read-only reader over the supervisor's store handle (`store.readOnly()`). */
export class VmControlProjection {
  constructor(readOnlyStore, { now = Date.now, liveEpoch = null } = {}) { this.store = readOnlyStore; this.now = now; this.liveEpoch = liveEpoch; }
  get(id) { const r = this.store.get(id); return r ? projectIntent(r, { now: this.now(), liveEpoch: this.liveEpoch }) : null; }
  list() { return this.store.list().map(r => projectIntent(r, { now: this.now(), liveEpoch: this.liveEpoch })); }
}
