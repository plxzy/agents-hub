// Memory notes in D1. A runner proposes candidates in its run receipt; only a panel click (with a one-time code)
// accepts or rejects one. Accepted notes are what later runs load for their scopes.
import { containsSecret } from './snapshot.mjs';
import { RUN_ID } from './runs.mjs';

export const SCOPE = /^(shared|project:[a-z0-9][a-z0-9_.-]{0,63}|agent:[a-z0-9][a-z0-9_-]{0,63})$/;
const ID = /^m-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const MAX_BODY = 2000, PER_RUN = 5, MAX_PENDING = 50;

async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Candidates from one finished run. Re-posting the same receipt inserts nothing new (ids derive from the content). */
export async function proposeMemory(env, { agent, run_id, items }) {
  if (!RUN_ID.test(run_id ?? '') || !Array.isArray(items)) return 0;
  const stamp = run_id.slice(2, 18), created = new Date().toISOString();
  const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'candidate'").first()) ?? { n: 0 };
  let added = 0;
  for (const item of items.slice(0, PER_RUN)) {
    const body = typeof item?.body === 'string' ? item.body.trim() : '';
    if (!body || body.length > MAX_BODY || containsSecret(body) || !SCOPE.test(item.scope ?? '')) continue;
    if (n + added >= MAX_PENDING) break;
    const id = `m-${stamp}-${(await digest(`${run_id}\n${item.scope}\n${body}`)).slice(0, 6)}`;
    const done = await env.DB.prepare(`INSERT OR IGNORE INTO memory (id, scope, status, body, proposed_by, source_run, created) VALUES (?, ?, 'candidate', ?, ?, ?, ?)`)
      .bind(id, item.scope, body, agent, run_id, created).run();
    added += done.meta?.changes === 1 ? 1 : 0;
  }
  return added;
}

/** Waiting notes as the panel's review items. */
export async function pendingMemory(env) {
  try {
    const { results } = await env.DB.prepare("SELECT id, scope, body, proposed_by, source_run FROM memory WHERE status = 'candidate' ORDER BY created DESC LIMIT 50").all();
    return results.map((r) => ({ id: r.id, kind: 'memory', agent: r.proposed_by, why: `${r.scope}${r.source_run ? ` · run ${r.source_run}` : ''}`, body: r.body }));
  } catch { return []; } // table missing before its migration
}

export async function isMemory(env, id) {
  if (!ID.test(id ?? '')) return false;
  return Boolean(await env.DB.prepare('SELECT 1 AS x FROM memory WHERE id = ?').bind(id).first());
}

export async function decideMemory(env, { id, decision, reason }) {
  if (!ID.test(id ?? '') || !['accept', 'reject'].includes(decision)) throw new Error('Invalid decision');
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 1000) : null;
  const done = await env.DB.prepare("UPDATE memory SET status = ?, decided = ?, reason = ? WHERE id = ? AND status = 'candidate'")
    .bind(status, new Date().toISOString(), text, id).run();
  if (done.meta?.changes !== 1) throw new Error('That note was already decided');
  return `${status} → ${id}`;
}

/** Accepted notes for the given scopes (what a run loads), newest last. */
export async function acceptedMemory(env, scopes) {
  const wanted = scopes.filter((s) => SCOPE.test(s));
  if (!wanted.length) return [];
  const { results } = await env.DB.prepare(`SELECT id, scope, body, supersedes FROM memory WHERE status = 'accepted' AND scope IN (${wanted.map(() => '?').join(',')}) ORDER BY created`).bind(...wanted).all();
  const superseded = new Set(results.map((r) => r.supersedes).filter(Boolean));
  return results.filter((r) => !superseded.has(r.id)).map(({ id, scope, body }) => ({ id, scope, body }));
}

export async function pendingCounts(env) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'candidate'").first();
    return Number.isInteger(row?.n) ? row.n : null;
  } catch { return null; }
}

/** What a runner loads for an agent: its accepted notes and a hash that identifies exactly this content. */
export async function bundleFor(env, scopes) {
  const memory = await acceptedMemory(env, scopes);
  return { memory, hash: (await digest(JSON.stringify(memory))).slice(0, 16) };
}
