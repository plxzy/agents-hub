// The user's own decisions on runs the Hub holds (D1). The panel gets one-time codes in a tool result's `_meta`
// (hosts pass that to the widget, never to the model); a decision without an unused matching code is refused, even if a
// host ignored the tools' app-only visibility.
import { RUN_ID, redactLines } from './runs.mjs';

const TTL = 30 * 60 * 1000;
// D1 allows at most 100 bound parameters per statement.
const chunks = (ids, n = 90) => Array.from({ length: Math.ceil(ids.length / n) }, (_, i) => ids.slice(i * n, i * n + n));
const marks = (ids) => ids.map(() => '?').join(',');
const bytes = () => crypto.getRandomValues(new Uint8Array(18));
const code = () => btoa(String.fromCharCode(...bytes())).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Codes for many targets at once; panels refresh often, so a code with over half its life left is reused. */
export async function issueCodes(env, kind, targets, now = Date.now()) {
  await env.DB.prepare('DELETE FROM confirmations WHERE expires < ?').bind(now).run();
  const out = {};
  for (const part of chunks(targets)) {
    const { results } = await env.DB.prepare(`SELECT code, target FROM confirmations WHERE kind = ? AND expires > ? AND target IN (${marks(part)})`)
      .bind(kind, now + TTL / 2, ...part).all();
    for (const r of results) out[r.target] ??= r.code;
  }
  const fresh = targets.filter((t) => !Object.hasOwn(out, t)).map((t) => [t, code()]);
  if (fresh.length) await env.DB.batch(fresh.map(([target, c]) => env.DB.prepare('INSERT INTO confirmations (code, kind, target, expires) VALUES (?, ?, ?, ?)').bind(c, kind, target, now + TTL)));
  for (const [target, c] of fresh) out[target] = c;
  return out;
}

/** Spends a code atomically: the same code never works twice. */
export async function redeemCode(env, value, kind, target, now = Date.now()) {
  const done = typeof value === 'string' && value.length <= 64
    ? await env.DB.prepare('DELETE FROM confirmations WHERE code = ? AND kind = ? AND target = ? AND expires > ?').bind(value, kind, target, now).run() : null;
  if (done?.meta?.changes !== 1) throw new Error('This decision needs a click in the Agents Hub panel (refresh the panel and try again).');
}

/** Spends several codes in one batch; returns the targets whose code was valid (each code still works only once). */
export async function redeemCodes(env, kind, pairs, now = Date.now()) {
  const valid = pairs.filter(([value]) => typeof value === 'string' && value.length <= 64);
  if (!valid.length) return [];
  const results = await env.DB.batch(valid.map(([value, target]) =>
    env.DB.prepare('DELETE FROM confirmations WHERE code = ? AND kind = ? AND target = ? AND expires > ?').bind(value, kind, target, now)));
  return valid.filter((_, i) => results[i]?.meta?.changes === 1).map(([, target]) => target);
}

export async function rateRun(env, { run_id, rating, comment }, now = new Date()) {
  if (!RUN_ID.test(run_id ?? '') || !['good', 'bad'].includes(rating)) throw new Error('Invalid rating');
  const run = await env.DB.prepare('SELECT status FROM runs WHERE run_id = ?').bind(run_id).first();
  if (!run) throw new Error('Unknown run ' + run_id);
  if (run.status === 'running') throw new Error('Rate a run after it finishes');
  const text = redactLines(typeof comment === 'string' ? comment : '', 4000) || null;
  await env.DB.prepare(`INSERT INTO ratings (run_id, rating, comment, rated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, rated_at = excluded.rated_at`)
    .bind(run_id, rating, text, now.toISOString()).run();
  return `rated ${run_id} ${rating}`;
}

/** run_id -> { rating, comment } for the given ids (empty if the table is missing before its migration). */
export async function ratingsFor(env, ids) {
  if (!env.DB || !ids.length) return new Map();
  try {
    const results = [];
    for (const part of chunks(ids)) results.push(...(await env.DB.prepare(`SELECT run_id, rating, comment FROM ratings WHERE run_id IN (${marks(part)})`).bind(...part).all()).results);
    return new Map(results.map((r) => [r.run_id, { rating: r.rating, ...(r.comment ? { comment: r.comment } : {}) }]));
  } catch { return new Map(); }
}

/** Decisions made in the panel since a time, for the Mac to mirror into its git copy (one-way: Hub to Mac). */
export async function decisionsSince(env, since) {
  const t = typeof since === 'string' && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : '1970-01-01T00:00:00.000Z';
  const notes = (await env.DB.prepare("SELECT id, scope, status, body, proposed_by, source_run, created, decided, reason, supersedes FROM memory WHERE status IN ('accepted','rejected') AND decided > ? ORDER BY decided LIMIT 200").bind(t).all()).results;
  const ratings = (await env.DB.prepare('SELECT run_id, rating, comment, rated_at FROM ratings WHERE rated_at > ? ORDER BY rated_at LIMIT 500').bind(t).all()).results;
  return { notes, ratings };
}
