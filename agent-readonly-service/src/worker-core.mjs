const KEEP_SNAPSHOTS = 20;
const CAPABILITIES = { discovery: true, status: true, context: true, run: false, mutate: false };
const DASHBOARD_URI = 'ui://agents-hub/dashboard.html';
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

function snapshotData(snap, env) {
  const m = meta(snap, env);
  return { ...m, status: { agents: snap.payload.agents.length, runs: snap.payload.runs.length, running: snap.payload.runs.filter((r) => r.status === 'running').length,
      pending: { memory: 0, proposals: 0 }, last_run: snap.payload.runs.at(-1) ?? null },
    agents: snap.payload.agents, runs: snap.payload.runs.slice(-50), pending: [] };
}

const TOOLS = [
  { name: 'open_dashboard', title: 'Agents Hub dashboard', description: 'Open the read-only Agents Hub dashboard with agents, recent runs, provenance and freshness.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, ui: true, run: (p) => snapshotData(p.snap, p.env) },
  { name: 'list_agents', title: 'List agents', description: 'List sanitized local agent definitions from the latest published snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (p) => ({ ...p.meta, agents: p.snap.payload.agents }) },
  { name: 'list_runs', title: 'List runs', description: 'List sanitized recent agent runs with task titles, status and provenance.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    run: (p, { agent, limit = 20 }) => ({ ...p.meta, ...page(p.snap.payload.runs.filter((r) => !agent || r.agent === agent), null, limit) }) },
  { name: 'get_run', title: 'Get a run', description: 'Inspect one sanitized run by id.',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: { type: 'string' } }, additionalProperties: false },
    run: (p, { run_id }) => { const run = p.snap.payload.runs.find((r) => r.run_id === run_id); if (!run) throw new Error('no run ' + run_id); return { ...p.meta, run }; } },
  { name: 'get_status', title: 'Agents Hub status', description: 'Show snapshot freshness, provenance and explicitly advertised capabilities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (p) => ({ ...p.meta, agents: p.snap.payload.agents.length, runs: p.snap.payload.runs.length }) },
  { name: 'resolve_context', title: 'Resolve context', description: 'List approved context metadata from the latest published snapshot.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    run: (p, { limit = 20 }) => ({ ...p.meta, ...page(p.snap.payload.context ?? [], null, limit) }) },
];

const toolList = TOOLS.map(({ run, ui, ...tool }) => ({
  ...tool, annotations: { readOnlyHint: true },
  ...(ui ? { _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/outputTemplate': DASHBOARD_URI } } : {}),
}));

export async function apiFetch(request, env, dashboardHtml = '') {
  const url = new URL(request.url);
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
        return reply({ content: [{ type: 'text', text: tool.ui ? 'Agents Hub dashboard' : JSON.stringify(value, null, 2) }], ...(tool.ui ? { structuredContent: value } : {}) });
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

function claim(request) {
  // Cloudflare Access authenticates the browser before it reaches this Worker. The JWT is
  // deliberately only used as the provider subject; Access remains the verifier.
  const raw = request.headers.get('cf-access-jwt-assertion');
  if (!raw) return null;
  try { const payload = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return payload.sub || payload.email || null; } catch { return null; }
}

function escape(value) { return String(value).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'); }

export async function defaultFetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'agents-hub', capabilities: CAPABILITIES });
  if (url.pathname === '/authorize') {
    const oauth = env.OAUTH_PROVIDER;
    const userId = claim(request);
    if (!userId) return json({ error: 'login_required', message: 'Sign in through Cloudflare Access before authorizing Agents Hub.' }, 401);
    try {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      if (request.method === 'GET') {
        const consent = await oauth.beginConsent(authRequest);
        const html = '<!doctype html><meta charset="utf-8"><title>Authorize Agents Hub</title><h1>Allow ' + escape(details.clientName) + ' to read Agents Hub?</h1><p>Redirect: ' + escape(details.redirectHost) + '</p><form method="post"><input type="hidden" name="handle" value="' + escape(consent.handle) + '"><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form>';
        consent.headers.set('content-type', 'text/html; charset=utf-8');
        return new Response(html, { headers: consent.headers });
      }
      const form = await request.formData();
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, String(form.get('handle')));
        denied.headers.set('location', denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, String(form.get('handle')), { scope: ['agents.read'], remember: { secret: env.CONSENT_SECRET, subject: userId } });
      const completed = await oauth.completeAuthorization({ request: approved.request, userId, metadata: {}, scope: ['agents.read'], props: { userId } });
      approved.headers.set('location', completed.redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      if (e?.redirectTo) return Response.redirect(e.redirectTo, 302);
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

