// Pure, additive observations shared by Node, the Worker and the dashboard. No I/O or execution authority.
export function healthTime(value, now = Date.now()) {
  if (value == null) return { at: null, age_ms: null, problem: 'missing' };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return { at: null, age_ms: null, problem: 'malformed' };
  const time = Date.parse(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== normalized) return { at: null, age_ms: null, problem: 'malformed' };
  if (time > now) return { at: null, age_ms: null, problem: 'future' };
  return { at: new Date(time).toISOString(), age_ms: now - time, problem: null };
}

const boolean = (value) => typeof value === 'boolean' ? value : null;
const agents = (value) => Array.isArray(value) && value.every((x) => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x)) ? [...new Set(value)].sort() : null;

/** Raw get_status/open_dashboard observations, not a previous health report. Offline data never authorizes runs. */
export function healthOf(data = {}, { now = Date.now(), snapshotMaxAge = 900000, relayMaxAge = 30000 } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const relay = data.relay ?? {};
  const seen = healthTime(relay.last_seen_at, now), observed = healthTime(relay.observed_at, now);
  const online = relay.available === false ? null : boolean(relay.online);
  const timedOut = seen.age_ms !== null && seen.age_ms >= relayMaxAge || observed.age_ms !== null && observed.age_ms >= relayMaxAge;
  const badTime = [seen, observed].some((t) => t.problem === 'future' || t.problem === 'malformed');
  const state = relay.available === false || badTime ? 'unknown' : online === false || timedOut ? 'disconnected' : online === true ? 'connected' : 'unknown';
  const freshness = badTime ? 'unknown' : timedOut ? 'stale' : state === 'connected' && seen.at && observed.at ? 'fresh' : 'unknown';
  const live = state === 'connected' && freshness === 'fresh';
  const historical = relay.last_known ?? (online === true && timedOut ? relay : {});
  const configured = data.configuration ?? {};
  const knownAt = healthTime(historical.observed_at, now);
  const observedAgents = live ? agents(relay.agents) : knownAt.at ? agents(historical.agents) : null;
  const configuredAgents = agents(configured.agents);
  const expected = ['helper']; // Diagnostic expectation only; the Mac's private configuration remains authoritative.
  const matches = observedAgents === null ? null : JSON.stringify(observedAgents) === JSON.stringify(expected);
  const enabled = live ? boolean(relay.enabled) : null;
  const available = state === 'disconnected' ? false : !live || enabled === null || matches === null ? null : enabled && matches;
  const snap = data.snapshot;
  const generated = healthTime(snap?.generated_at, now), published = healthTime(snap?.published_at, now);
  const snapshotState = !snap || snap.available === false ? 'unavailable' : generated.problem || published.problem ? 'unknown'
    : generated.age_ms > snapshotMaxAge || snap.stale === true ? 'stale' : 'fresh';
  // Sanitized snapshots do not establish origin. Only a journal-backed collector can supply this field.
  const run = data.last_successful_relay_run;
  const ended = healthTime(run?.ended, now);
  const lastRun = run?.origin === 'relay-journal' && typeof run.run_id === 'string' && /^r-[a-zA-Z0-9_-]+$/.test(run.run_id) && ended.at
    ? { run_id: run.run_id, ended: ended.at, source: 'relay-journal', historical: true } : null;
  const exitCode = state === 'disconnected' || matches === false ? 1 : !live || enabled === null || matches === null ? 2 : 0;
  return {
    schema_version: 1, observed_at: new Date(now).toISOString(), exit_code: exitCode,
    relay: { state, freshness, observed_at: observed.at, last_seen_at: seen.at, age_ms: seen.age_ms,
      time_problem: badTime ? 'malformed or future relay timestamp' : null, source: data.relay_source ?? 'unavailable' },
    execution: { enabled, available, configured_enabled: boolean(configured.enabled),
      reason: enabled === false ? 'deliberately off (not an outage)' : state === 'disconnected' ? 'relay disconnected; no remote starts'
        : available === true ? 'fresh relay, enabled, helper-only allowlist' : 'permission or liveness not established' },
    allowlist: { expected, observed: observedAgents, authority: observedAgents === null ? 'unavailable' : live ? 'live' : 'last-known',
      observed_at: live ? observed.at : knownAt.at, matches_expected: matches, configured: configuredAgents, configuration_source: configured.source ?? 'unavailable' },
    snapshot: { state: snapshotState, age_ms: generated.age_ms, generated_at: generated.at, published_at: published.at,
      generated_time_problem: generated.problem, published_time_problem: published.problem, source: snap && snap.available !== false ? 'published snapshot' : 'unavailable',
      capabilities: snap && snap.available !== false ? { run: boolean(data.capabilities?.run), mutate: boolean(data.capabilities?.mutate) } : null },
    last_successful_relay_run: lastRun,
    history_limitation: lastRun ? 'historical completion, not a heartbeat' : data.history_limitation ?? 'run origin/completion not established by the available snapshot',
    versions: { relay_protocol: Number.isInteger(relay.protocol_version) ? relay.protocol_version : null,
      node: typeof data.versions?.node === 'string' ? data.versions.node : null },
  };
}

export function healthLabels(h) {
  const age = h.snapshot.age_ms === null ? 'age unknown' : `age ${Math.floor(h.snapshot.age_ms / 1000)}s`;
  const allowed = h.allowlist.observed?.join(', ') || (h.allowlist.observed ? 'none' : 'unknown');
  return [
    `Relay: ${h.relay.state} · ${h.relay.freshness} · source ${h.relay.source} · last seen ${h.relay.last_seen_at ?? 'unknown'}`,
    `Remote execution: ${h.execution.enabled === false ? 'deliberately off' : h.execution.enabled === true ? 'enabled' : 'unknown'} · ${h.execution.reason}`,
    `Allowlist (${h.allowlist.authority}): ${allowed} · expected helper · ${h.allowlist.matches_expected === null ? 'comparison unknown' : h.allowlist.matches_expected ? 'matches' : 'MISMATCH'} · observed ${h.allowlist.observed_at ?? 'unknown'}`,
    `Snapshot: ${h.snapshot.state} · ${age} · generated ${h.snapshot.generated_at ?? 'unknown'} · published ${h.snapshot.published_at ?? 'unknown'} · source ${h.snapshot.source} · capabilities.run ${h.snapshot.capabilities?.run ?? 'unknown'}`,
    `Last successful relay run: ${h.last_successful_relay_run ? `${h.last_successful_relay_run.run_id} at ${h.last_successful_relay_run.ended} (historical; relay-journal)` : `unknown · ${h.history_limitation}`}`,
    `Configuration allowlist: ${h.allowlist.configured?.join(', ') || (h.allowlist.configured ? 'none' : 'unknown')} · enabled ${h.execution.configured_enabled ?? 'unknown'} · source ${h.allowlist.configuration_source} (not liveness)`,
    `Versions: relay protocol ${h.versions.relay_protocol ?? 'unknown'} · local Node ${h.versions.node ?? 'unknown'}`,
    `Health observed ${h.observed_at}`,
  ];
}
