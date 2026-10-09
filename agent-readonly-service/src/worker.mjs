import { page, sanitizeSnapshot } from './snapshot.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const unauthorized = () => json({ error: 'unauthorized' }, 401);

async function latest(env) {
  const row = await env.DB.prepare('SELECT id, published_at, payload FROM snapshots ORDER BY published_at DESC LIMIT 1').first();
  if (!row) return null;
  return { id: row.id, published_at: row.published_at, payload: JSON.parse(row.payload) };
}

function auth(request, env, write = false) {
  const expected = write ? env.PUBLISH_TOKEN : env.READ_TOKEN;
  return Boolean(expected && request.headers.get('authorization') === `Bearer ${expected}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'agent-readonly', capabilities: { discovery: true, status: true, context: true, execute: false, mutate: false } });
    if (request.method === 'POST' && url.pathname === '/v1/snapshots') {
      if (!auth(request, env, true)) return unauthorized();
      let payload;
      try { payload = sanitizeSnapshot(await request.json()); } catch (e) { return json({ error: e.message }, 400); }
      const id = crypto.randomUUID(); const publishedAt = new Date().toISOString();
      await env.DB.prepare('INSERT INTO snapshots (id, published_at, payload) VALUES (?, ?, ?)').bind(id, publishedAt, JSON.stringify(payload)).run();
      return json({ id, published_at: publishedAt, schema_version: payload.schema_version }, 201);
    }
    if (request.method !== 'GET' || !url.pathname.startsWith('/v1/')) return json({ error: 'not_found' }, 404);
    if (!auth(request, env)) return unauthorized();
    const snap = await latest(env); if (!snap) return json({ error: 'unavailable', reason: 'no_snapshot' }, 503);
    const age = Date.now() - Date.parse(snap.payload.generated_at); const stale = !Number.isFinite(age) || age > Number(env.STALE_AFTER_MS ?? 900000);
    const meta = { snapshot_id: snap.id, published_at: snap.published_at, generated_at: snap.payload.generated_at, stale, capabilities: snap.payload.capabilities };
    if (url.pathname === '/v1/agents') return json({ ...meta, ...page(snap.payload.agents, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
    if (url.pathname.startsWith('/v1/agents/')) { const item = snap.payload.agents.find((x) => x.name === decodeURIComponent(url.pathname.slice('/v1/agents/'.length))); return item ? json({ ...meta, item }) : json({ error: 'not_found' }, 404); }
    if (url.pathname === '/v1/runs') return json({ ...meta, ...page(snap.payload.runs, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
    if (url.pathname.startsWith('/v1/runs/')) { const item = snap.payload.runs.find((x) => x.run_id === decodeURIComponent(url.pathname.slice('/v1/runs/'.length))); return item ? json({ ...meta, item }) : json({ error: 'not_found' }, 404); }
    if (url.pathname === '/v1/context') return json({ ...meta, ...page(snap.payload.context, url.searchParams.get('cursor'), url.searchParams.get('limit')) });
    return json({ error: 'not_found' }, 404);
  },
};
