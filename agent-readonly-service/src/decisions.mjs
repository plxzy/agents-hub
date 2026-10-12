// The user's own decisions on runs the Hub holds (D1). The panel gets one-time codes in a tool result's `_meta`
// (hosts pass that to the widget, never to the model); a decision without an unused matching code is refused, even if a
// host ignored the tools' app-only visibility.
import { RUN_ID, redactLines } from './runs.mjs';

const TTL = 30 * 60 * 1000;
const bytes = () => crypto.getRandomValues(new Uint8Array(18));
const code = () => btoa(String.fromCharCode(...bytes())).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Codes for many targets at once; panels refresh often, so a code with over half its life left is reused. */
export async function issueCodes(env, kind, targets, now = Date.now()) {
  await env.DB.prepare('DELETE FROM confirmations WHERE expires < ?').bind(now).run();
  const out = {};
  for (const target of targets) {
    const old = await env.DB.prepare('SELECT code FROM confirmations WHERE kind = ? AND target = ? AND expires > ? LIMIT 1').bind(kind, target, now + TTL / 2).first();
    if (old) { out[target] = old.code; continue; }
    const fresh = code();
    await env.DB.prepare('INSERT INTO confirmations (code, kind, target, expires) VALUES (?, ?, ?, ?)').bind(fresh, kind, target, now + TTL).run();
    out[target] = fresh;
  }
  return out;
}

/** Spends a code atomically: the same code never works twice. */
export async function redeemCode(env, value, kind, target, now = Date.now()) {
  const done = typeof value === 'string' && value.length <= 64
    ? await env.DB.prepare('DELETE FROM confirmations WHERE code = ? AND kind = ? AND target = ? AND expires > ?').bind(value, kind, target, now).run() : null;
  if (done?.meta?.changes !== 1) throw new Error('This decision needs a click in the Agents Hub panel (refresh the panel and try again).');
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
    const marks = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT run_id, rating, comment FROM ratings WHERE run_id IN (${marks})`).bind(...ids).all();
    return new Map(results.map((r) => [r.run_id, { rating: r.rating, ...(r.comment ? { comment: r.comment } : {}) }]));
  } catch { return new Map(); }
}
