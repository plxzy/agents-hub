import { validateRelay } from '../../agent-workflow/relay-contract.mjs';
const json = (x, status = 200) => Response.json(x, { status, headers: { 'cache-control': 'no-store' } });
export async function relayStatus(env) {
  if (!env.RELAY_TOKEN) return { online: false, enabled: false, agents: [] };
  const row = await env.DB.prepare('SELECT * FROM relay_status WHERE id = 1').first();
  const online = !!row && Date.now() - row.seen < 15000;
  return { online, enabled: online && !!row.enabled, agents: online ? JSON.parse(row.agents) : [] };
}
async function authenticated(request, env) {
  if (!env.RELAY_TOKEN) return false;
  const digest = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(request.headers.get('authorization') ?? ''), digest('Bearer ' + env.RELAY_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}
export async function relayFetch(request, env) {
  if (!(await authenticated(request, env))) return json({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const text = await request.text();
  if (text.length > 262144) return json({ error: 'too_large' }, 413);
  let body; try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad_json' }, 400);
  const now = Date.now();
  if (new URL(request.url).pathname === '/relay/poll') {
    if (typeof body.enabled !== 'boolean' || !Array.isArray(body.agents) || body.agents.length > 100 || body.agents.some((x) => typeof x !== 'string' || x.length > 100)) return json({ error: 'bad_status' }, 400);
    await env.DB.prepare('DELETE FROM relay_jobs WHERE expires < ?').bind(now - 300000).run();
    await env.DB.prepare('INSERT INTO relay_status (id, seen, enabled, agents) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen, enabled=excluded.enabled, agents=excluded.agents')
      .bind(now, Number(body.enabled), JSON.stringify(body.agents)).run();
    // Atomic claim. Never redeliver a claimed job after a disconnect or Mac crash.
    const job = await env.DB.prepare("UPDATE relay_jobs SET state = 'claimed' WHERE id = (SELECT id FROM relay_jobs WHERE state = 'pending' AND expires > ? ORDER BY created LIMIT 1) RETURNING id, operation, args, expires")
      .bind(now).first();
    return json({ job: job ? { ...job, args: JSON.parse(job.args) } : null });
  }
  if (new URL(request.url).pathname === '/relay/complete') {
    if (typeof body.id !== 'string' || !body.result || typeof body.result.ok !== 'boolean') return json({ error: 'bad_result' }, 400);
    await env.DB.prepare("UPDATE relay_jobs SET state = 'done', args = NULL, result = ? WHERE id = ? AND state = 'claimed'")
      .bind(JSON.stringify(body.result), body.id).run();
    return json({ ok: true });
  }
  return json({ error: 'not_found' }, 404);
}
export async function requestRelay(env, operation, args, { wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  validateRelay(operation, args);
  const status = await relayStatus(env);
  if (!status.online) throw new Error('Mac is offline. No action was queued.');
  if (operation === 'start_run' && (!status.enabled || !status.agents.includes(args.agent))) throw new Error('Remote runs are off or this agent is not remote-allowed.');
  const id = args.request_id ?? crypto.randomUUID();
  const serialized = JSON.stringify(args);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operation + '\n' + serialized));
  const fingerprint = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare("INSERT OR IGNORE INTO relay_jobs (id, operation, args, state, created, expires, fingerprint) SELECT ?, ?, ?, 'pending', ?, ?, ? WHERE (SELECT COUNT(*) FROM relay_jobs WHERE state != 'done' AND expires > ?) < 32")
    .bind(id, operation, serialized, now(), now() + 20000, fingerprint, now()).run();
  for (let n = 0; n < 36; n++) {
    const row = await env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?').bind(id).first();
    if (!row) throw new Error('Relay is busy. No action was queued.');
    if (row.fingerprint !== fingerprint) throw new Error('request_id already belongs to a different action');
    if (row.state === 'done') {
      const result = JSON.parse(row.result);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }
    if (row.expires <= now()) break;
    await wait(500);
  }
  await env.DB.prepare("DELETE FROM relay_jobs WHERE id = ? AND state = 'pending'").bind(id).run();
  throw new Error(`Relay response unavailable; action may have completed. Check runs or retry with the SAME request_id: ${id}`);
}
