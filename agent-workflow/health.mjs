// Pure, additive observations shared by Node, the Worker and the dashboard. No I/O or execution authority.
const CLOCK_SKEW_MS = 5000;
export function healthTime(value, now = Date.now()) {
  if (value == null) return { at: null, age_ms: null, problem: 'missing' };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return { at: null, age_ms: null, problem: 'malformed' };
  const time = Date.parse(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== normalized) return { at: null, age_ms: null, problem: 'malformed' };
  // The runner's Durable Object and the Worker read different clocks; a few seconds ahead is skew, not a bad timestamp.
  if (time > now + CLOCK_SKEW_MS) return { at: null, age_ms: null, problem: 'future' };
  return { at: new Date(time).toISOString(), age_ms: Math.max(0, now - time), problem: null };
}

const boolean = (value) => typeof value === 'boolean' ? value : null;
const agents = (value) => Array.isArray(value) && value.every((x) => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x)) ? [...new Set(value)].sort() : null;

/** Raw get_status/open_dashboard observations, not a previous health report. Offline data never authorizes runs. */
export function healthOf(data = {}, { now = Date.now(), snapshotMaxAge = 900000, relayMaxAge = 30000, expected = ['helper'] } = {}) {
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
  // `expected` is a diagnostic expectation only (the runner's own configuration stays authoritative).
  const matches = observedAgents === null ? null : JSON.stringify(observedAgents) === JSON.stringify([...expected].sort());
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
        : available === true ? 'fresh relay, enabled, expected agents match' : 'permission or liveness not established' },
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

/** Keep hosted snapshot/DO observations, adding only journal-backed history and runtime metadata from the live panel. */
export function dashboardHealth(hosted, live, { now = Date.now() } = {}) {
  const h = hosted.health ?? healthOf(hosted, { now }), local = live.health;
  if (!local) return h;
  const run = local.last_successful_relay_run;
  const proven = healthOf({ last_successful_relay_run: run?.source === 'relay-journal' && run.historical === true
    ? { ...run, origin: 'relay-journal' } : null }, { now }).last_successful_relay_run;
  const history = proven ?? h.last_successful_relay_run;
  return { ...h, last_successful_relay_run: history,
    history_limitation: history ? 'historical completion, not a heartbeat' : run ? 'live history lacks valid journal-backed completion evidence'
      : local.history_limitation ?? h.history_limitation,
    versions: { ...h.versions, node: typeof local.versions?.node === 'string' ? local.versions.node : h.versions.node } };
}

export function healthLabels(h) {
  const allowed = h.allowlist.observed?.join(', ') || (h.allowlist.observed ? 'none' : 'not reported');
  const online = h.relay.state === 'connected' && h.relay.freshness === 'fresh';
  return [
    online ? `dok online · runs: ${h.execution.enabled === false ? 'paused' : allowed}`
      : h.relay.state === 'disconnected' ? 'dok offline' : 'dok status unknown',
    `Last seen: ${h.relay.last_seen_at ?? 'not reported'} · ${h.relay.freshness} · ${h.relay.source}`,
    `Execution: ${h.execution.enabled === false ? 'deliberately off' : h.execution.enabled === true ? 'enabled' : 'not established'}`,
    ...(!online && h.allowlist.observed ? [`Runs (${h.allowlist.authority}): ${allowed}`] : []),
    ...(h.allowlist.matches_expected === false ? ['Agent configuration: MISMATCH'] : []),
    ...(h.last_successful_relay_run ? [`Last completed relay run: ${h.last_successful_relay_run.run_id} at ${h.last_successful_relay_run.ended} (historical)`] : []),
    ...(h.allowlist.configured ? [`Configured runs: ${h.allowlist.configured.join(', ') || 'none'}`] : []),
    ...(h.versions.relay_protocol !== null ? [`Relay protocol: ${h.versions.relay_protocol}`] : []),
    ...(h.versions.node ? [`Node: ${h.versions.node}`] : []),
    `Observed: ${h.observed_at}`,
  ];
}
