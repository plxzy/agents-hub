import { DASHBOARD_URI, READ_OPS, lastRunOf } from '../../agent-workflow/contract.mjs';
import { accessSubject } from './access.mjs';

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
  const age = Date.now() - Date.parse(snap.payload.generated_at);
  return { snapshot_id: snap.id, published_at: snap.published_at, generated_at: snap.payload.generated_at,
    stale: !Number.isFinite(age) || age > Number(env.STALE_AFTER_MS ?? 900000), capabilities: snap.payload.capabilities ?? CAPABILITIES };
}

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
  ...(ui ? { _meta: { ui: { resourceUri: ui }, 'openai/outputTemplate': ui } } : {}),
}));

export async function apiFetch(request, env, dashboardHtml = '') {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/mcp/v1/')) url.pathname = url.pathname.slice(4);
  if (request.method !== 'POST' || url.pathname !== '/mcp') {
    if (request.method !== 'GET' || !url.pathname.startsWith('/v1/')) return json({ error: 'not_found' }, 404);
  }
  const snap = await latest(env);
  if (!snap) return json({ error: 'unavailable', reason: 'no_snapshot' }, 503);
  const m = meta(snap, env);
  if (url.pathname === '/mcp') {
    let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
    const { id, method, params } = msg ?? {};
    if (id === undefined || id === null) return new Response(null, { status: 202 });
    const reply = (result) => json({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'agents-hub', title: 'Agents Hub', version: '0.3.0' },
      instructions: 'Read-only Agents Hub view of the user’s local agents and runs. Check get_status for freshness; run is explicitly unavailable.' });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: toolList });
    if (method === 'resources/list') return reply({ resources: [{ uri: DASHBOARD_URI, name: 'Agents Hub dashboard', mimeType: MCP_MIME }] });
    if (method === 'resources/read') {
      if (params?.uri !== DASHBOARD_URI) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown resource' } });
      return reply({ contents: [{ uri: DASHBOARD_URI, mimeType: MCP_MIME, text: dashboardHtml, _meta: { ui: { prefersBorder: true } } }] });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((x) => x.name === params?.name);
      if (!tool) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params?.name } });
      try {
        const value = tool.run({ snap, env, meta: m }, params.arguments ?? {});
        return reply({ content: [{ type: 'text', text: tool.ui ? tool.summary(value) : JSON.stringify(value, null, 2) }], ...(tool.ui ? { structuredContent: value } : {}) });
      } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
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

function escape(value) { return String(value).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'); }

export async function defaultFetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'agents-hub', capabilities: CAPABILITIES });
  if (url.pathname === '/authorize') {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
    const oauth = env.OAUTH_PROVIDER;
    const userId = await accessSubject(request, env);
    if (!userId) return json({ error: 'login_required', message: 'Sign in through Cloudflare Access before authorizing Agents Hub.' }, 401);
    try {
      if (request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        const publisher = details.clientDomain ? 'Published by ' + escape(details.clientDomain) : 'This app registered itself; its name is not verified.';
        const html = '<!doctype html><meta charset="utf-8"><title>Authorize Agents Hub</title><h1>Allow ' + escape(details.clientName) + ' to read Agents Hub?</h1><p>' + publisher + '</p><p>Redirect: ' + escape(details.redirectHost) + '</p><p>Permission: agents.read — read your published agents and runs.</p>' + (details.redirectIsLoopback ? '<p>Continue only if you just started signing in from an app on your computer.</p>' : '') + '<form method="post" action="/authorize"><input type="hidden" name="handle" value="' + escape(consent.handle) + '"><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form>';
        consent.headers.set('content-type', 'text/html; charset=utf-8');
        return new Response(html, { headers: consent.headers });
      }
      const form = await request.formData();
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, String(form.get('handle')));
        denied.headers.set('location', denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, String(form.get('handle')), { scope: ['agents.read'] });
      const completed = await oauth.completeAuthorization({ request: approved.request, userId, metadata: {}, scope: ['agents.read'], props: { userId } });
      approved.headers.set('location', completed.redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      if (e?.name === 'AuthorizationError' && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (['AuthorizationError', 'CimdFetchError'].includes(e?.name)) return json({ error: 'invalid_authorization_request' }, 400);
      throw e;
    }
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

