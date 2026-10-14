import { publishReview, publicationHealth } from './review-publications.mjs';
import { dokTarget } from '../../agent-workflow/run-selection.mjs';
import { withFailureGuidance } from '../../agent-workflow/run-trace.mjs';
import { DASHBOARD_URI, isDashboardUri, DASHBOARD_TOOL_META, DASHBOARD_RESOURCE_META, DASHBOARD_ICONS, READ_OPS, lastRunOf } from '../../agent-workflow/contract.mjs';
import { accessSubject } from './access.mjs';
import { RELAY_OPS, relayToolList, validateRelay } from '../../agent-workflow/relay-contract.mjs';
import { relayFetch, startRun, getRun, getStartStatus, resumeRun, dokEnabled, dokStatus } from './relay.mjs';
import { readRun, recentRuns, mergeRuns } from './runs.mjs';
import { readAccounts } from './accounts.mjs';
import { issueCodes, redeemCode, rateRun } from './decisions.mjs';
import { agentSummaries } from './knowledge.mjs';
import { pendingMemory, pendingCounts, isMemory, decideMemory } from './memory.mjs';
import { healthOf, healthTime } from '../../agent-workflow/health.mjs';
import { DEV_OPS, developmentTools } from '../../agent-workflow/dev-contract.mjs';
import { developmentCall } from './development.mjs';

const KEEP_SNAPSHOTS = 20;
const CAPABILITIES = { discovery: true, status: true, context: true, run: false, mutate: false };
const MCP_MIME = 'text/html;profile=mcp-app';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const unauthorized = () => json({ error: 'unauthorized' }, 401);

async function latest(env) {
  const row = await env.DB.prepare('SELECT id, published_at, payload FROM snapshots ORDER BY published_at DESC LIMIT 1').first();
  return row ? { id: row.id, published_at: row.published_at, payload: JSON.parse(row.payload) } : null;
}

function meta(snap, env) {
  const now = Date.now(), generated = healthTime(snap.payload.generated_at, now), published = healthTime(snap.published_at, now);
  return { snapshot_id: snap.id, published_at: snap.published_at, generated_at: snap.payload.generated_at,
    stale: generated.problem !== null || published.problem !== null || generated.age_ms > snapshotMaxAge(env), capabilities: snap.payload.capabilities ?? CAPABILITIES };
}

const snapshotMaxAge = (env) => Number.isFinite(Number(env.STALE_AFTER_MS)) && Number(env.STALE_AFTER_MS) >= 0 ? Number(env.STALE_AFTER_MS) : 900000;

function page(items, cursor, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const start = Number.isInteger(Number(cursor)) ? Number(cursor) : 0;
  return { items: items.slice(start, start + n), next_cursor: start + n < items.length ? String(start + n) : null };
}

// Results follow the shared contract (agent-workflow/contract.mjs), so the one dashboard reads local and hosted data
// alike. `snapshot` says how old the data is; pending is null when the snapshot did not carry review counts.
const freshness = (m) => ({ published_at: m.published_at, generated_at: m.generated_at, stale: m.stale });

function status(snap) {
  const runs = snap.payload.runs;
  const last = runs.filter((r) => r.status !== 'running').at(-1);
  return { agents: snap.payload.agents.length, runs: runs.length, running: runs.filter((r) => r.status === 'running').length,
    pending: snap.payload.pending ?? null, last_run: last ? { run_id: last.run_id, agent: last.agent, status: last.status, ended: last.ended } : null };
}
const agents = (snap) => snap.payload.agents.map((a) => ({ ...a, last_run: lastRunOf(a.name, snap.payload.runs) }));

function snapshotData(snap, m) {
  return { generated_at: m.generated_at, capabilities: m.capabilities, status: status(snap), agents: agents(snap),
    runs: snap.payload.runs.slice(-50), pending: null, snapshot: freshness(m) };
}

const TOOLS = [
  { name: 'open_dashboard', ...READ_OPS.open_dashboard,
    description: READ_OPS.open_dashboard.description + ' Hosted: read-only, from the last published snapshot.', run: (p) => snapshotData(p.snap, p.meta) },
  { name: 'get_status', ...READ_OPS.get_status, run: (p) => ({ ...status(p.snap), snapshot: freshness(p.meta), capabilities: p.meta.capabilities }) },
  { name: 'list_agents', ...READ_OPS.list_agents, run: (p) => ({ snapshot: freshness(p.meta), agents: agents(p.snap) }) },
  { name: 'list_runs', ...READ_OPS.list_runs,
    run: (p, { agent, limit = 10 }) => ({ snapshot: freshness(p.meta), runs: p.snap.payload.runs.filter((r) => !agent || r.agent === agent).slice(-limit) }) },
  { name: 'get_run', ...READ_OPS.get_run,
    run: (p, { run_id }) => { const run = p.snap.payload.runs.find((r) => r.run_id === run_id); if (!run) throw new Error('no run ' + run_id); return { ...withFailureGuidance(run), snapshot: freshness(p.meta) }; } },
  { name: 'resolve_context', title: 'Resolve context', description: 'List approved context metadata from the latest published snapshot.', annotations: { readOnlyHint: true },
    input: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    run: (p, { limit = 20 }) => ({ snapshot: freshness(p.meta), ...page(p.snap.payload.context ?? [], null, limit) }) },
];

// Counts must come from runs the Hub actually holds, not only from a snapshot the Mac last published.
function hubCounts(snapRuns, hubRuns) {
  const runs = mergeRuns(snapRuns ?? [], hubRuns), last = runs.filter((r) => r.status !== 'running').at(-1);
  return { runs: runs.length, running: runs.filter((r) => r.status === 'running').length,
    last_run: last ? { run_id: last.run_id, agent: last.agent, status: last.status, ended: last.ended } : null };
}

// Panel data without the Mac: runs from D1 (plus any snapshot runs), the dok runner's agents and one-time codes for
// rating finished Hub runs. The dashboard treats `relay` as "a hosted runner is online", so dok presents itself there.
async function nativePanel(env, { withConfirm = false } = {}) {
  // Independent reads run together: each D1 round trip can cost tens of milliseconds.
  const [snap, hubRuns, dok, published, notes, publicationHealthNow] = await Promise.all([latest(env), recentRuns(env, { limit: 50 }), dokStatus(env),
    agentSummaries(env), pendingMemory(env), publicationHealth(env)]);
  const m = snap ? meta(snap, env) : null;
  const base = snap ? snapshotData(snap, m) : { generated_at: null, capabilities: CAPABILITIES, status: { agents: null, runs: null, running: null, pending: null, last_run: null },
    agents: [], runs: [], pending: null, snapshot: { available: false, generated_at: null, published_at: null, stale: true } };
  if (published.length) base.agents = published.map((a) => ({ ...a, last_run: lastRunOf(a.name, mergeRuns(snap?.payload.runs ?? [], hubRuns)) }));
  const known = new Set(base.agents.map((a) => a.name));
  const agents = [...base.agents.map((a) => ({ ...a, remote_allowed: dok.agents.includes(a.name) })),
    ...dok.agents.filter((n) => !known.has(n)).map((name) => ({ name, description: 'Runs on dok.', remote_allowed: true, last_run: null }))];
  const runs = mergeRuns(base.runs, hubRuns).slice(-50);
  // Only the authenticated Hub widget requests codes. Mac reads do not even issue them.
  const [rate, review, recovery] = withConfirm ? await Promise.all([
    issueCodes(env, 'rate', hubRuns.filter((r) => ['completed', 'failed', 'interrupted'].includes(r.status)).map((r) => r.run_id)),
    issueCodes(env, 'review', notes.map((n) => n.id)),
    issueCodes(env, 'recovery', hubRuns.filter(r => r.recovery?.state === 'awaiting_review' && r.recovery?.checkpoint_version).map(r => `${r.run_id}:${r.recovery.checkpoint_version}`)),
  ]) : [];
  const confirm = withConfirm ? { rate, review, recovery } : null;
  const pending = [...notes, ...(base.pending ?? []).filter((p) => p.kind !== 'memory')];
  const relay = { ...dok, runner: 'dok' };
  // The same health report open_dashboard gives, so the panel can poll this one call alone.
  const health = runnerHealth(healthOf({ ...base, relay, relay_source: dok.available === false ? 'Durable Object status unavailable' : 'Durable Object status' },
    { snapshotMaxAge: snapshotMaxAge(env), expected: dok.agents }), dok);
  return { ...base, source: 'hub', generated_at: new Date().toISOString(), agents, runs, pending, health, hub_panel: true,
    development_available: Boolean(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true'),
    publication_health: publicationHealthNow,
    run_targets: [dokTarget(dok, agents)],
    status: { ...base.status, agents: agents.length, ...hubCounts(snap?.payload.runs, hubRuns), pending: { memory: notes.length, proposals: pending.length - notes.length } },
    capabilities: { ...base.capabilities, run: withConfirm && dok.online && dok.agents.length > 0, mutate: withConfirm },
    ...(confirm ? { confirm } : {}), relay };
}

function runnerHealth(health, dok) {
  if (dok.online && dok.agents.length) health.execution = { ...health.execution, available: true, runner: 'dok', reason: `dok runner online; start_run runs: ${dok.agents.join(', ')}` };
  return health;
}

/**
 * A short fingerprint of everything the panel shows, from a handful of indexed or tiny reads, so the panel can poll
 * often and fetch the full data only when it changed. Timestamps that move on every heartbeat are left out; the panel
 * still does a full read at least once a minute (labels, codes). null when it cannot be computed.
 */
async function panelVersion(env, owner) {
  try {
    const q = (sql) => env.DB.prepare(sql);
    const [rows, dok, development] = await Promise.all([
      env.DB.batch([
        q('SELECT MAX(updated_at) AS v FROM runs'),
        q("SELECT COUNT(*) AS n, MAX(created) AS c, MAX(decided) AS d FROM memory WHERE status = 'candidate' OR decided IS NOT NULL"),
        q('SELECT COUNT(*) AS n, MAX(rated_at) AS v FROM ratings'),
        q(`SELECT group_concat(run_id || ':' || status || ':' || attempts || ':' || COALESCE(pr_url, '') || ':' || COALESCE(error, ''), '|') AS v
          FROM review_publications WHERE run_id IN (SELECT run_id FROM runs ORDER BY started DESC LIMIT 50)`),
        q("SELECT group_concat(root || ':' || COALESCE(observation, ''), '|') AS v FROM review_threads"),
        q("SELECT group_concat(slot || ':' || state || ':' || updated_at, '|') AS v FROM accounts"),
        q("SELECT value AS v FROM knowledge_state WHERE key = 'revision'"),
        q('SELECT observed_at AS v FROM review_publisher_health WHERE id = 1'),
      ]),
      dokStatus(env),
      owner && env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true' ? developmentCall(env, owner, 'get_development', {}).then((d) => d.grants).catch(() => null) : null,
    ]);
    const [runs, memory, ratings, publications, threads, accounts, revision, publisher] = rows.map((r) => r.results);
    const publisherOnline = !!publisher[0]?.v && Date.now() - Date.parse(publisher[0].v) < 60000;
    const text = JSON.stringify([runs, memory, ratings, publications, threads, accounts, revision, publisherOnline,
      [dok.online, dok.enabled, dok.available, dok.agents, dok.pending_starts, dok.run_selection], development]);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

const toolList = TOOLS.map(({ name, title, description, input, annotations, ui }) => ({
  name, title, description, inputSchema: input, annotations: { title, ...annotations, readOnlyHint: true },
  ...(ui ? { icons: DASHBOARD_ICONS, _meta: DASHBOARD_TOOL_META } : {}),
}));

export async function apiFetch(request, env, dashboardHtml = '', owner = null) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/mcp/v1/')) url.pathname = url.pathname.slice(4);
  if (request.method !== 'POST' || url.pathname !== '/mcp') {
    if (request.method !== 'GET' || !url.pathname.startsWith('/v1/')) return json({ error: 'not_found' }, 404);
  }
  if (url.pathname === '/mcp') {
    let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
    const { id, method, params } = msg ?? {};
    // Connection, discovery and UI resources must work before the first snapshot is published.
    if (id === undefined || id === null) return new Response(null, { status: 202 });
    const reply = (result) => json({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'agents-hub', title: 'Agents Hub', version: '0.4.0' },
      instructions: dokEnabled(env)
        ? 'Agents Hub runs the user\u2019s own Pi agents. They run on dok, the user\u2019s always-on Linux runner, so the Mac does not need to be online. For questions about the user\u2019s repositories (where something is, how it works) call start_run with a read-only agent such as helper. For coding work call start_run with an agent that changes files (the agents get_status lists under start_run.runners.dok, e.g. workflow for dev-workflow, vm, tikkytracker): it works in an isolated clone on dok and returns a saved review. GitHub-enabled repositories automatically publish draft PRs; poll get_run.publication for the PR URL or blocker. A completed coding run alone does not establish publication. Nothing is merged. Read get_run first and follow next_action. Completed reviews need continue_from; eligible failed work needs resume_run. A run ID only in task prose does not attach its files. Never substitute a fresh main clone for retained work. Poll get_run for results. Prefer start_run over delegating to Codex cloud tasks or driving the user\u2019s Mac. request_development (approval card, then start_development_task) is the older interactive route for workflow. Ratings and reviews are user clicks in the panel, never model decisions.'
        : 'Read-only Agents Hub view of the user’s local agents and runs. Check get_status for freshness; run is explicitly unavailable.' });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [...(dokEnabled(env) ? [
      ...toolList.map((t) => t.name === 'open_dashboard' ? { ...t, description: READ_OPS.open_dashboard.description + ' The panel shows runs, agents and the review queue held by the Hub.' } : t),
      ...relayToolList().filter((t) => ['publish_review', 'start_run', 'get_start_status', 'resume_run', 'decide_recovery', 'get_remote_run', 'panel_data', 'panel_run', 'rate_run', 'review_decide'].includes(t.name)),
    ] : toolList), ...(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true' ? developmentTools() : [])] });
    if (method === 'resources/list') return reply({ resources: [{ uri: DASHBOARD_URI, name: 'Agents Hub dashboard', mimeType: MCP_MIME }] });
    if (method === 'resources/read') {
      if (!isDashboardUri(params?.uri)) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown resource' } });
      return reply({ contents: [{ uri: DASHBOARD_URI, mimeType: MCP_MIME, text: dashboardHtml, _meta: DASHBOARD_RESOURCE_META }].map((c) => ({ ...c, uri: params.uri })) });
    }
    if (method === 'tools/call') {
      if (params?.name === 'publish_review' && dokEnabled(env)) {
        try { return reply({ content: [{ type: 'text', text: JSON.stringify(await publishReview(env, params.arguments)) }] }); }
        catch (e) { return reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
      }
      if (Object.hasOwn(DEV_OPS, params?.name ?? '')) {
        try {
          const { confirm, ...value } = await developmentCall(env, owner, params.name, params.arguments ?? {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(value) }],
            ...(params.name === 'request_development' ? { structuredContent: { ...value, view: 'development',
              next_step: 'The user must approve this session in the card. Then check get_development and submit the task with start_development_task.' } } : {}),
            ...(confirm ? { _meta: { 'agents-hub/development-confirm': confirm } } : {}) });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      // The panel, ratings and review decisions are served by the Hub from D1.
      if (dokEnabled(env) && ['panel_data', 'panel_run', 'rate_run', 'review_decide', 'decide_recovery'].includes(params?.name)) {
        try {
          const args = params.arguments ?? {};
          if (params.name === 'panel_data') {
            const version = await panelVersion(env, owner);
            if (version && args.since === version) return reply({ content: [{ type: 'text', text: JSON.stringify({ unchanged: true, version }) }] });
            const { confirm, ...value } = await nativePanel(env, { withConfirm: true });
            // The Development tab comes with the panel, so one host call refreshes everything.
            let devConfirm;
            if (value.development_available) {
              try { const { confirm: c, ...d } = await developmentCall(env, owner, 'development_panel', {}); value.development = d; devConfirm = c; }
              catch { /* the panel falls back to its own development_panel call */ }
            }
            return reply({ content: [{ type: 'text', text: JSON.stringify({ ...value, ...(version ? { version } : {}) }) }],
              _meta: { 'agents-hub/confirm': confirm, ...(devConfirm ? { 'agents-hub/development-confirm': devConfirm } : {}) } });
          }
          if (params.name === 'panel_run') {
            const run = await readRun(env, args.run_id);
            if (run) return reply({ content: [{ type: 'text', text: JSON.stringify(run) }] });
          }
          if (params.name === 'decide_recovery') {
            validateRelay('decide_recovery', args);
            await redeemCode(env, args.confirm, 'recovery', `${args.run_id}:${args.checkpoint_version}`);
            const { confirm: _confirm, ...resume } = args;
            return reply({ content: [{ type: 'text', text: JSON.stringify(await resumeRun(env, resume, { approved: true })) }] });
          }
          if (params.name === 'review_decide' && await isMemory(env, args.id)) {
            validateRelay('review_decide', args);
            await redeemCode(env, args.confirm, 'review', args.id);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await decideMemory(env, args)) }] });
          }
          if (params.name === 'rate_run' && await readRun(env, args.run_id)) {
            validateRelay('rate_run', args);
            await redeemCode(env, args.confirm, 'rate', args.run_id);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await rateRun(env, args)) }] });
          }
          if (params.name === 'panel_run') throw new Error('Unknown run ' + args.run_id);
          if (params.name === 'rate_run') throw new Error('Unknown run ' + args.run_id);
          if (params.name === 'review_decide') throw new Error('Unknown review item ' + args.id);
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      if (dokEnabled(env) && ['start_run', 'get_remote_run', 'get_start_status', 'resume_run'].includes(params?.name)) {
        try {
          const args = params.arguments ?? {};
          const result = params.name === 'start_run' ? await startRun(env, args)
            : params.name === 'get_start_status' ? await getStartStatus(env, args.request_id)
            : params.name === 'resume_run' ? await resumeRun(env, args) : await getRun(env, args.run_id);
          if (params.name === 'get_remote_run' && !result) throw new Error('Unknown run ' + args.run_id + ' (not in the Hub).');
          const { confirm, ...value } = result ?? {};
          // Confirmation codes go only to the panel: hosts pass a result's _meta to the widget, never to the model.
          return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(confirm ? { _meta: { 'agents-hub/confirm': confirm } } : {}) });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      const tool = TOOLS.find((x) => x.name === params?.name);
      if (!tool) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params?.name } });
      try {
        const healthRead = params.name === 'open_dashboard' || params.name === 'get_status';
        const args = params.arguments ?? {};
        // Runner receipts live in the Hub (D1): readable without the Mac or a fresh snapshot.
        if (params.name === 'get_run') {
          const hub = await readRun(env, args.run_id);
          if (hub) return reply({ content: [{ type: 'text', text: JSON.stringify(hub, null, 2) }] });
        }
        const hubRuns = ['list_runs', 'open_dashboard'].includes(params.name) ? await recentRuns(env, { agent: args.agent, limit: params.name === 'open_dashboard' ? 200 : 50 }) : [];
        const snap = await latest(env), m = snap ? meta(snap, env) : null;
        if (!snap && params.name === 'list_runs') return reply({ content: [{ type: 'text', text: JSON.stringify({ snapshot: null, runs: hubRuns.slice(-(args.limit ?? 10)) }, null, 2) }] });
        const published = ['list_agents', 'open_dashboard', 'get_status'].includes(params.name) ? await agentSummaries(env) : [];
        const withLast = (list, runs) => list.map((a) => ({ ...a, last_run: lastRunOf(a.name, runs) }));
        if (!snap && params.name === 'list_agents' && published.length) {
          return reply({ content: [{ type: 'text', text: JSON.stringify({ snapshot: null, agents: withLast(published, await recentRuns(env, { limit: 200 })) }, null, 2) }] });
        }
        if (!snap && !healthRead) return json({ error: 'unavailable', reason: 'no_snapshot' }, 503);
        const unknownStatus = { agents: null, runs: null, running: null, pending: null, last_run: null };
        const unavailable = { generated_at: null, capabilities: CAPABILITIES, snapshot: { available: false, generated_at: null, published_at: null, stale: true } };
        const value = snap ? tool.run({ snap, env, meta: m }, args)
          : params.name === 'get_status' ? { ...unknownStatus, ...unavailable }
          : { ...unavailable, status: unknownStatus, agents: [], runs: [], pending: null };
        // Published definitions (from git, via agent sync push) win over the snapshot's agent list.
        if (published.length) {
          const runsNow = mergeRuns(snap?.payload.runs ?? [], params.name === 'list_agents' ? await recentRuns(env, { limit: 200 }) : hubRuns);
          if (params.name === 'list_agents') value.agents = withLast(published, runsNow);
          else if (params.name === 'open_dashboard') { value.agents = withLast(published, runsNow); value.status = { ...value.status, agents: published.length }; }
          else value.agents = published.length;
        }
        if (healthRead) {
          const hubAll = params.name === 'open_dashboard' ? hubRuns : await recentRuns(env, { limit: 200 });
          // No snapshot and nothing in the Hub stays unknown, never zero.
          if (snap || hubAll.length) {
            const counts = hubCounts(snap?.payload.runs, hubAll), notes = await pendingCounts(env);
            const target = params.name === 'get_status' ? value : value.status;
            Object.assign(target, counts);
            // Notes waiting in the Hub; instruction proposals still come from the (possibly stale) snapshot.
            if (notes !== null) target.pending = { memory: notes, proposals: target.pending?.proposals ?? 0 };
          }
        }
        if (params.name === 'list_runs' && snap) value.runs = mergeRuns(snap.payload.runs.filter((r) => !args.agent || r.agent === args.agent), hubRuns).slice(-(args.limit ?? 10));
        if (params.name === 'open_dashboard') value.runs = mergeRuns(value.runs ?? [], hubRuns).slice(-50);
        if (healthRead) {
          value.development_available = Boolean(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true');
          value.hub_panel = dokEnabled(env);
          value.runners = { dok: await dokStatus(env) };
          value.accounts = await readAccounts(env);
          value.publication_health = await publicationHealth(env);
          // The runner (dok) is what the panel and the health report call "relay": the Mac no longer connects.
          value.relay = { ...value.runners.dok, runner: 'dok' };
          value.health = healthOf({ ...value, relay_source: value.relay.available === false ? 'Durable Object status unavailable' : 'Durable Object status' }, { snapshotMaxAge: snapshotMaxAge(env), expected: value.runners.dok.agents });
          // Callers decide from this summary whether start_run works.
          const dok = value.runners.dok, dokAgents = dok.online ? dok.agents : [];
          value.start_run = dokAgents.length
            ? { available: true, runners: { dok: dokAgents }, note: 'start_run works now: it runs on dok, the always-on Linux runner. Poll get_run for the result.' }
            : { available: false, note: 'dok is offline, so no runner is available.' };
          if (dokAgents.length) {
            runnerHealth(value.health, dok);
            if (params.name === 'get_status') value.capabilities = { ...value.capabilities, run: true };
          }
        }
        const shown = params.name === 'get_status' && value.start_run ? { start_run: value.start_run, ...value } : value;
        return reply({ content: [{ type: 'text', text: tool.ui ? tool.summary(value) : JSON.stringify(shown, null, 2) }], ...(tool.ui ? { structuredContent: value } : {}) });
      } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
  const snap = await latest(env);
  if (!snap) return json({ error: 'unavailable', reason: 'no_snapshot' }, 503);
  const m = meta(snap, env);
  if (url.pathname === '/v1/agents') return json({ ...m, ...page(snap.payload.agents, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
  if (url.pathname.startsWith('/v1/agents/')) {
    const item = snap.payload.agents.find((x) => x.name === decodeURIComponent(url.pathname.slice('/v1/agents/'.length)));
    return item ? json({ ...m, item }) : json({ error: 'not_found' }, 404);
  }
  if (url.pathname === '/v1/runs') return json({ ...m, ...page(snap.payload.runs, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
  if (url.pathname.startsWith('/v1/runs/')) {
    const item = snap.payload.runs.find((x) => x.run_id === decodeURIComponent(url.pathname.slice('/v1/runs/'.length)));
    return item ? json({ ...m, item: withFailureGuidance(item) }) : json({ error: 'not_found' }, 404);
  }
  if (url.pathname === '/v1/context') return json({ ...m, ...page(snap.payload.context ?? [], url.searchParams.get('cursor'), url.searchParams.get('limit')) });
  return json({ error: 'not_found' }, 404);
}

export async function defaultFetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'agents-hub', capabilities: CAPABILITIES });
  // Access points clients at its own metadata in the 401; this answers clients that look in the standard place.
  if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
    return json({ resource: url.origin + '/mcp', authorization_servers: [env.ACCESS_ISSUER], bearer_methods_supported: ['header'], resource_name: 'Agents Hub' });
  }
  if (request.method === 'POST' && url.pathname === '/v1/snapshots') {
    const token = request.headers.get('authorization');
    if (!env.PUBLISH_TOKEN || token !== 'Bearer ' + env.PUBLISH_TOKEN) return unauthorized();
    let payload; try { payload = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const { sanitizeSnapshot } = await import('./snapshot.mjs');
    try { payload = sanitizeSnapshot(payload); } catch (e) { return json({ error: e.message }, 400); }
    const id = crypto.randomUUID(); const publishedAt = new Date().toISOString();
    await env.DB.prepare('INSERT INTO snapshots (id, published_at, payload) VALUES (?, ?, ?)').bind(id, publishedAt, JSON.stringify(payload)).run();
    await env.DB.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY published_at DESC LIMIT ?)').bind(KEEP_SNAPSHOTS).run();
    return json({ id, published_at: publishedAt, schema_version: payload.schema_version }, 201);
  }
  return json({ error: 'not_found' }, 404);
}


/**
 * The whole Worker. Cloudflare Access (an Access application on /mcp with Managed OAuth) is the OAuth server: it
 * signs the user in, registers clients and issues tokens, then forwards each request with a signed
 * Cf-Access-Jwt-Assertion. The Worker checks that assertion itself too, so a request that reached it some other way
 * (a preview URL, a missing Access application) is refused. /health and the publisher's /v1/snapshots stay outside.
 */
export async function hubFetch(request, env, dashboardHtml = '', keys) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/relay/')) return relayFetch(request, env, () => nativePanel(env));
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    const owner = await accessSubject(request, env, keys);
    if (!owner) return unauthorized();
    return apiFetch(request, env, dashboardHtml, owner);
  }
  return defaultFetch(request, env);
}
