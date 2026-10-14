// Browser/Worker-safe public projection. Private checkpoints never cross the relay.
const STATES = ['ready', 'awaiting_review', 'paused', 'resumed', 'unavailable', 'completed'];
const run = v => typeof v === 'string' && /^r-\d{8}T\d{6}Z-[a-f0-9]{6}$/.test(v) ? v : undefined;
// Only trusted failure diagnostics participate, never task text or model prose.
export function retryableModelFailure(r = {}) {
  const f = r.failure_context;
  return r.error === 'model turn failed' && f?.phase === 'model'
    && /stream ended before a terminal response event|\bECONNRESET\b|\bETIMEDOUT\b|\b(?:502|503|504)\b/.test(f.message ?? '');
}
export const recoveryEligible = r => r?.status === 'interrupted' || (r?.status === 'failed' && retryableModelFailure(r));
export function recoveryAction(r = {}) {
  const v = r.recovery;
  if (!recoveryEligible(r) || !v?.retained || !Number.isSafeInteger(v.checkpoint_version) || v.checkpoint_version < 1) return null;
  if (v.state === 'ready') return 'resume_run';
  if (v.state === 'awaiting_review' && v.inspection) return 'decide_recovery';
  return null;
}
export function publicRecovery(v) {
  if (!v || !STATES.includes(v.state)) return undefined;
  return Object.fromEntries(Object.entries({ state: v.state,
    revision: Number.isSafeInteger(v.revision) && v.revision >= 1 ? v.revision : undefined,
    checkpoint_version: Number.isSafeInteger(v.checkpoint_version) && v.checkpoint_version > 0 ? v.checkpoint_version : undefined,
    checkpoint_at: typeof v.checkpoint_at === 'string' && v.checkpoint_at.length < 40 && Number.isFinite(Date.parse(v.checkpoint_at)) ? v.checkpoint_at : undefined,
    resumed_from: run(v.resumed_from), resumed_by: run(v.resumed_by),
    retained: v.retained === true,
    reason: typeof v.reason === 'string' && /^[A-Za-z0-9 ;:.,_-]{1,180}$/.test(v.reason) ? v.reason : undefined,
    inspection: typeof v.inspection === 'string' ? v.inspection.slice(0, 12000) : undefined,
  }).filter(([, value]) => value !== undefined));
}
