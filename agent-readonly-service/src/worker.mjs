import { page, sanitizeSnapshot } from './snapshot.mjs';

const KEEP_SNAPSHOTS = 20;
const CAPABILITIES = { discovery: true, status: true, context: true, execute: false, mutate: false };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const unauthorized = () => json({ error: 'unauthorized' }, 401);

async function latest(env) {
  const row = await env.DB.prepare('SELECT id, published_at, payload FROM snapshots ORDER BY published_at DESC LIMIT 1').first();
  if (!row) return null;
  return { id: row.id, published_at: row.published_at, payload: JSON.parse(row.payload) };
}

/** Constant-time string comparison, so response timing reveals nothing about the token. */
function same(a, b) {
  const x = new TextEncoder().encode(a); const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function auth(request, env, write = false) {
  const expected = write ? env.PUBLISH_TOKEN : env.READ_TOKEN;
  return Boolean(expected) && same(request.headers.get('authorization') ?? '', `Bearer ${expected}`);
}

function meta(snap, env) {
  const age = Date.now() - Date.parse(snap.payload.generated_at);
  return { snapshot_id: snap.id, published_at: snap.published_at, generated_at: snap.payload.generated_at,
    stale: !Number.isFinite(age) || age > Number(env.STALE_AFTER_MS ?? 900000), capabilities: snap.payload.capabilities };
}

// ---------- MCP (streamable HTTP, JSON responses only), read-only ----------

const TOOLS = [
  { name: 'list_agents', description: "List the user's local agents (name, purpose, model, tools, skills, guard, workspace). Read-only snapshot published from the user's Mac.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (p) => ({ ...p.meta, agents: p.payload.agents }) },
  { name: 'list_runs', description: 'Recent agent runs (newest last): agent, kind, status, task title, model, tool calls, tokens, cost, user rating.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { agent: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
    run: (p, { agent, limit = 20 }) => ({ ...p.meta, runs: p.payload.runs.filter((r) => !agent || r.agent === agent).slice(-Math.min(Math.max(Number(limit) || 20, 1), 100)) }) },
  { name: 'get_run', description: 'One run by id.',
    inputSchema: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string' } } },
    run: (p, { run_id }) => { const run = p.payload.runs.find((r) => r.run_id === run_id); if (!run) throw new Error(`no run ${run_id}`); return { ...p.meta, run }; } },
  { name: 'get_status', description: 'When the snapshot was published, whether it is stale, and what this server can do (read-only: it cannot run agents or change anything).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (p) => ({ ...p.meta, agents: p.payload.agents.length, runs: p.payload.runs.length }) },
];

async function mcp(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return new Response(null, { status: 202 }); // notifications
  const reply = (result) => json({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
    serverInfo: { name: 'agents-readonly', version: '0.2.0' },
    instructions: "Read-only view of the user's local agents and their recent runs, published from their Mac. It cannot run agents or change anything; check get_status for freshness." });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS.map(({ run, ...t }) => ({ ...t, annotations: { readOnlyHint: true } })) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    const snap = await latest(env);
    if (!snap) return reply({ content: [{ type: 'text', text: 'No snapshot has been published yet.' }], isError: true });
    try { return reply({ content: [{ type: 'text', text: JSON.stringify(tool.run({ meta: meta(snap, env), payload: snap.payload }, params.arguments ?? {}), null, 2) }] }); }
    catch (e) { return reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }); }
  }
  return json({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'agent-readonly', capabilities: CAPABILITIES });
    if (request.method === 'POST' && url.pathname === '/v1/snapshots') {
      if (!auth(request, env, true)) return unauthorized();
      let payload;
      try { payload = sanitizeSnapshot(await request.json()); } catch (e) { return json({ error: e.message }, 400); }
      const id = crypto.randomUUID(); const publishedAt = new Date().toISOString();
      await env.DB.prepare('INSERT INTO snapshots (id, published_at, payload) VALUES (?, ?, ?)').bind(id, publishedAt, JSON.stringify(payload)).run();
      await env.DB.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY published_at DESC LIMIT ?)').bind(KEEP_SNAPSHOTS).run();
      return json({ id, published_at: publishedAt, schema_version: payload.schema_version }, 201);
    }
    // MCP for hosted clients: bearer token, or the token as the last path segment for hosts that can only store a URL.
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      const pathToken = url.pathname.slice('/mcp/'.length);
      const ok = auth(request, env) || (pathToken && env.READ_TOKEN && same(pathToken, env.READ_TOKEN));
      return ok ? mcp(request, env) : unauthorized();
    }
    if (request.method !== 'GET' || !url.pathname.startsWith('/v1/')) return json({ error: 'not_found' }, 404);
    if (!auth(request, env)) return unauthorized();
    const snap = await latest(env); if (!snap) return json({ error: 'unavailable', reason: 'no_snapshot' }, 503);
    const m = meta(snap, env);
    if (url.pathname === '/v1/agents') return json({ ...m, ...page(snap.payload.agents, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
    if (url.pathname.startsWith('/v1/agents/')) { const item = snap.payload.agents.find((x) => x.name === decodeURIComponent(url.pathname.slice('/v1/agents/'.length))); return item ? json({ ...m, item }) : json({ error: 'not_found' }, 404); }
    if (url.pathname === '/v1/runs') return json({ ...m, ...page(snap.payload.runs, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
    if (url.pathname.startsWith('/v1/runs/')) { const item = snap.payload.runs.find((x) => x.run_id === decodeURIComponent(url.pathname.slice('/v1/runs/'.length))); return item ? json({ ...m, item }) : json({ error: 'not_found' }, 404); }
    if (url.pathname === '/v1/context') return json({ ...m, ...page(snap.payload.context, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
    return json({ error: 'not_found' }, 404);
  },
};
