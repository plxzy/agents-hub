import { DASHBOARD_URI, isDashboardUri, DASHBOARD_TOOL_META, DASHBOARD_RESOURCE_META, DASHBOARD_ICONS, READ_OPS, lastRunOf } from '../../agent-workflow/contract.mjs';
import { accessSubject } from './access.mjs';
import { RELAY_OPS, relayToolList } from '../../agent-workflow/relay-contract.mjs';
import { relayFetch, relayStatus, requestRelay } from './relay.mjs';
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
    run: (p, { run_id }) => { const run = p.snap.payload.runs.find((r) => r.run_id === run_id); if (!run) throw new Error('no run ' + run_id); return { ...run, snapshot: freshness(p.meta) }; } },
  { name: 'resolve_context', title: 'Resolve context', description: 'List approved context metadata from the latest published snapshot.', annotations: { readOnlyHint: true },
    input: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    run: (p, { limit = 20 }) => ({ snapshot: freshness(p.meta), ...page(p.snap.payload.context ?? [], null, limit) }) },
];

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
      serverInfo: { name: 'agents-hub', title: 'Agents Hub', version: '0.3.0' },
      instructions: env.RELAY_TOKEN
        ? 'Agents Hub: published read metadata plus a live Mac relay. start_run is for remote-allowed Mac agents only. For workflow development on dok-dev, call request_development to show a session approval card; wait for the user click, check get_development, then call start_development_task. If these tools are missing, refresh the Agents Hub connection or use its Development panel. Use get_remote_run for Mac relay output. Ratings and reviews are user clicks in the panel, never model decisions.'
        : 'Read-only Agents Hub view of the user’s local agents and runs. Check get_status for freshness; run is explicitly unavailable.' });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [...(env.RELAY_TOKEN ? [
      ...toolList.map((t) => t.name === 'open_dashboard' ? { ...t, description: READ_OPS.open_dashboard.description + ' The unified panel uses the linked Mac when online and a published snapshot otherwise.' } : t),
      ...relayToolList(),
    ] : toolList), ...(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true' ? developmentTools() : [])] });
    if (method === 'resources/list') return reply({ resources: [{ uri: DASHBOARD_URI, name: 'Agents Hub dashboard', mimeType: MCP_MIME }] });
    if (method === 'resources/read') {
      if (!isDashboardUri(params?.uri)) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown resource' } });
      return reply({ contents: [{ uri: DASHBOARD_URI, mimeType: MCP_MIME, text: dashboardHtml, _meta: DASHBOARD_RESOURCE_META }].map((c) => ({ ...c, uri: params.uri })) });
    }
    if (method === 'tools/call') {
      if (Object.hasOwn(DEV_OPS, params?.name ?? '')) {
        try {
          const { confirm, ...value } = await developmentCall(env, owner, params.name, params.arguments ?? {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(value) }],
            ...(params.name === 'request_development' ? { structuredContent: { ...value, view: 'development',
              next_step: 'The user must approve this session in the card. Then check get_development and submit the task with start_development_task.' } } : {}),
            ...(confirm ? { _meta: { 'agents-hub/development-confirm': confirm } } : {}) });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      if (env.RELAY_TOKEN && RELAY_OPS[params?.name]) {
        try {
          if (params.name === 'start_run' && params.arguments?.agent === 'workflow') {
            throw new Error('start_run targets the Mac and cannot approve workflow development. Call request_development with a unique request_id to display the dok-dev approval card; after the user approves, use start_development_task. If those tools are missing, refresh the Agents Hub connection or open Agents Hub > Development. No task was started.');
          }
          const { confirm, ...value } = await requestRelay(env, params.name, params.arguments ?? {}) ?? {};
          // Confirmation codes go only to the panel: hosts pass a result's _meta to the widget, never to the model.
          return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(confirm ? { _meta: { 'agents-hub/confirm': confirm } } : {}) });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      const tool = TOOLS.find((x) => x.name === params?.name);
      if (!tool) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params?.name } });
      try {
        const healthRead = params.name === 'open_dashboard' || params.name === 'get_status';
        const snap = await latest(env), m = snap ? meta(snap, env) : null;
        if (!snap && !healthRead) return json({ error: 'unavailable', reason: 'no_snapshot' }, 503);
        const unknownStatus = { agents: null, runs: null, running: null, pending: null, last_run: null };
        const unavailable = { generated_at: null, capabilities: CAPABILITIES, snapshot: { available: false, generated_at: null, published_at: null, stale: true } };
        const value = snap ? tool.run({ snap, env, meta: m }, params.arguments ?? {})
          : params.name === 'get_status' ? { ...unknownStatus, ...unavailable }
          : { ...unavailable, status: unknownStatus, agents: [], runs: [], pending: null };
        if (healthRead) {
          value.development_available = Boolean(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true');
          value.relay = await relayStatus(env);
          value.health = healthOf({ ...value, relay_source: value.relay.available === false ? 'Durable Object status unavailable' : 'Durable Object status' }, { snapshotMaxAge: snapshotMaxAge(env) });
        }
        return reply({ content: [{ type: 'text', text: tool.ui ? tool.summary(value) : JSON.stringify(value, null, 2) }], ...(tool.ui ? { structuredContent: value } : {}) });
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
    return item ? json({ ...m, item }) : json({ error: 'not_found' }, 404);
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
  if (pathname.startsWith('/relay/')) return relayFetch(request, env);
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    const owner = await accessSubject(request, env, keys);
    if (!owner) return unauthorized();
    return apiFetch(request, env, dashboardHtml, owner);
  }
  return defaultFetch(request, env);
}
