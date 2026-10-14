// Liveness is based on a fresh observation, never on historical success.
const CLOCK_SKEW_MS = 5_000;
export function healthTime(value, now = Date.now()) {
  if (value == null) return { at: null, age_ms: null, problem: 'missing' };
  if (typeof value !== 'string') return { at: null, age_ms: null, problem: 'malformed' };
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return { at: null, age_ms: null, problem: 'malformed' };
  // Runner and host read different clocks; a few seconds ahead is skew, not a bad timestamp.
  if (time > now + CLOCK_SKEW_MS) return { at: null, age_ms: null, problem: 'future' };
  return { at: value, age_ms: Math.max(0, now - time), problem: null };
}

export function healthOf(data = {}, { now = Date.now(), maxAge = 30_000 } = {}) {
  const source = data.observation ?? {};
  const seen = healthTime(source.seen_at, now);
  const fresh = seen.problem === null && seen.age_ms < maxAge;
  const online = typeof source.online === 'boolean' ? source.online : null;
  const state = !fresh ? 'unknown' : online === true ? 'connected' : online === false ? 'disconnected' : 'unknown';
  return {
    observed_at: new Date(now).toISOString(),
    state,
    freshness: fresh ? 'fresh' : seen.problem === 'missing' ? 'missing' : 'stale',
    seen_at: seen.at,
    age_ms: seen.age_ms,
    online,
    execution_available: state === 'connected' && source.execution_available === true,
    history_limitation: 'Historical completion does not establish current liveness.',
  };
}
