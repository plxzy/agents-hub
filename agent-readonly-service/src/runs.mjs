import { ensurePublication, readPublication, readReview, publicationsAndReviews } from './review-publications.mjs';
// Run receipts in D1: written by authenticated runners, read by the Hub's MCP tools.
import { publicRecovery } from '../../agent-workflow/recovery-contract.mjs';
import { containsSecret } from './secrets.mjs';
import { runBrief, titleOf } from '../../agent-workflow/contract.mjs';
import { ratingsFor, redeemCodes } from './decisions.mjs';
import { proposeMemory } from './memory.mjs';
import { sanitizeFailureContext } from '../../agent-workflow/failure-telemetry.mjs';
import { sanitizeProgress } from '../../agent-workflow/run-progress.mjs';
import { withFailureGuidance, publicRunContext } from '../../agent-workflow/run-trace.mjs';
import { runConfiguration, runtimeConfig } from '../../agent-workflow/run-config.mjs';
import { readArtifact } from './run-artifacts.mjs';
import { publicSourceReview, publicSourcePr } from '../../agent-workflow/run-continuation.mjs';

// r-… task runs and evals, c-… chats
export const RUN_ID = /^[rc]-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const STATUS = ['running', 'completed', 'failed', 'interrupted'];
// Archiving keeps the panel fast; this caps what D1 holds (oldest runs are deleted first).
const KEEP = 500;
export const MAC_HEARTBEAT_TTL_MS = 90000;
// dok re-sends a running receipt every 5 seconds, even when nothing changed.
export const DOK_CONTACT_TTL_MS = 60000;
const iso = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined;
const num = (v) => Number.isFinite(v) && v >= 0 ? v : undefined;
const short = (v, max) => typeof v === 'string' && v.length <= max ? v : undefined;
// Line-wise redaction keeps useful answers while dropping anything that looks like a credential.
export function redactLines(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.split('\n').map((line) => containsSecret(line) ? '[redacted line: looked like a secret]' : line).join('\n');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Normalise a runner's receipt; unknown fields are dropped and the runner comes from the authenticated route. */
export function sanitizeReceipt(r, runner) {
  if (!r || typeof r !== 'object' || !RUN_ID.test(r.run_id ?? '') || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.agent ?? '')
    || !STATUS.includes(r.status) || !iso(r.started)) throw new Error('Invalid run receipt');
  const runtime = runtimeConfig(r.runtime);
  const configuration = runConfiguration({ runtime: r.runtime, mcp_connection: r.configuration?.mcp_connection ?? r.mcp_connection });
  const usage = r.usage && typeof r.usage === 'object' ? Object.fromEntries(['input', 'output', 'totalTokens', 'cost']
    .map((k) => [k, num(r.usage[k])]).filter(([, v]) => v !== undefined)) : undefined;
  const out = {
    request_id: runner === 'dok' && /^[A-Za-z0-9_-]{8,80}$/.test(r.request_id ?? '') ? r.request_id : undefined,
    run_id: r.run_id, agent: r.agent, kind: ['task', 'chat', 'eval'].includes(r.kind) ? r.kind : 'task', runner, status: r.status,
    title: redactLines(titleOf(r.task ?? r.title ?? ''), 200), task: redactLines(r.task, 16000),
    started: iso(r.started), ended: iso(r.ended), model: short(r.model, 100), thinking: short(r.thinking, 20),
    agent_version: short(r.agent_version, 40), commit: /^[a-f0-9]{40,64}$/.test(r.commit ?? '') ? r.commit : undefined,
    blocked: Array.isArray(r.blocked) ? Math.min(r.blocked.length, 1000) : Number.isInteger(r.blocked) && r.blocked >= 0 ? Math.min(r.blocked, 1000) : undefined,
    tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls.filter((t) => /^[a-z_]{1,40}$/.test(t)).slice(0, 500) : undefined,
    model_calls: Number.isInteger(r.model_calls) && r.model_calls >= 0 ? r.model_calls : undefined,
    accounts_used: Array.isArray(r.accounts_used) ? r.accounts_used.filter((x) => /^openai(-[1-9]\d*)?$/.test(x)).slice(0, 10) : undefined,
    repo: /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(r.repo ?? '') ? r.repo : undefined,
    ...publicRunContext(r),
    ...(r.github_base && /^[a-f0-9]{40}$/.test(r.github_base.commit) && iso(r.github_base.observed_at)
      ? { github_base: { commit: r.github_base.commit, observed_at: iso(r.github_base.observed_at) } } : {}),
    base_commit: /^[a-f0-9]{40,64}$/.test(r.base_commit ?? '') ? r.base_commit : undefined,
    review_ref: new RegExp(`^refs/heads/review/runs/${r.run_id}$`).test(r.review_ref ?? '') ? r.review_ref : undefined,
    review_conversation_id: runner === 'dok' && RUN_ID.test(r.review_conversation_id ?? r.root ?? '') ? (r.review_conversation_id ?? r.root) : undefined,
    continued_from: RUN_ID.test(r.continued_from ?? '') ? r.continued_from : undefined,
    source_review: publicSourceReview(r.source_review),
    source_pr: publicSourcePr(r.source_pr),
    changed_files: Array.isArray(r.changed_files) ? r.changed_files.filter((f) => typeof f === 'string' && f.length <= 300 && !/[\r\n]/.test(f)).slice(0, 200) : undefined,
    memory_proposed: Number.isInteger(r.memory_proposed) && r.memory_proposed >= 0 && r.memory_proposed <= 20 ? r.memory_proposed : undefined,
    memory_source: ['hub', 'frozen-release'].includes(r.memory_source) ? r.memory_source : undefined,
    memory_hash: /^[a-f0-9]{16}$/.test(r.memory_hash ?? '') ? r.memory_hash : undefined,
    recovery: publicRecovery(r.recovery ? { ...r.recovery, inspection: redactLines(r.recovery.inspection, 12000) } : null),
    usage, runtime, configuration, progress: sanitizeProgress(r.progress), error: redactLines(r.error, 200), output: redactLines(r.output, 48000),
    ...(r.status !== 'completed' && r.status !== 'running' ? {
      failure_context: sanitizeFailureContext(r.failure_context), output_partial: r.output_partial === true,
    } : {}),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/** Upsert; a final receipt is never replaced by a late "running" one or by another runner. */
export async function storeRun(env, receipt, runner) {
  if (!env.DB) throw new Error('Run store unavailable');
  const r = sanitizeReceipt(receipt, runner);
  await env.DB.prepare(`INSERT INTO runs (run_id, agent, runner, status, started, ended, updated_at, receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, ended=excluded.ended, updated_at=excluded.updated_at, receipt=excluded.receipt
    WHERE runs.runner = excluded.runner
      AND COALESCE(json_extract(excluded.receipt, '$.recovery.revision'), 0) >= COALESCE(json_extract(runs.receipt, '$.recovery.revision'), 0)
      AND (runs.status = 'running' OR excluded.status <> 'running')
      AND (excluded.status <> 'running' OR COALESCE(json_extract(excluded.receipt, '$.progress.observed_at'), '') >= COALESCE(json_extract(runs.receipt, '$.progress.observed_at'), ''))`)
    .bind(r.run_id, r.agent, runner, r.status, r.started, r.ended ?? null, new Date().toISOString(), JSON.stringify(r)).run();
  await env.DB.prepare('DELETE FROM runs WHERE run_id NOT IN (SELECT run_id FROM runs ORDER BY started DESC LIMIT ?)').bind(KEEP).run();
  // Notes the agent asked to remember become candidates for the user's review (idempotent per run and content).
  if (r.status !== 'running' && Array.isArray(receipt.memory_proposals)) {
    try { await proposeMemory(env, { agent: r.agent, run_id: r.run_id, items: receipt.memory_proposals }); } catch { /* the receipt is stored; the runner retries unreported receipts */ }
  }
  await ensurePublication(env, r);
  return r;
}

/** Missing contact is unknown, not proof of failure. Keep stored state running so a heartbeat can recover it. */
export function observedRun(row, now = Date.now()) {
  const receipt = JSON.parse(row.receipt);
  if (!['mac', 'dok'].includes(receipt.runner) || receipt.status !== 'running') return receipt;
  const seen = Date.parse(row.updated_at), age = now - seen, mac = receipt.runner === 'mac';
  return { ...receipt, last_seen_at: row.updated_at,
    ...(!Number.isFinite(age) || age < 0 || age >= (mac ? MAC_HEARTBEAT_TTL_MS : DOK_CONTACT_TTL_MS)
      ? { status: 'unknown', error: mac ? 'Mac heartbeat expired; the run may still be active. Waiting for contact or a final receipt.'
        : 'dok has not reported this run for over a minute; it may still be active. Check get_status for the runner, then poll again.' } : {}) };
}

export async function readRun(env, runId) {
  if (!env.DB || !RUN_ID.test(runId ?? '')) return null;
  const row = await env.DB.prepare('SELECT receipt, updated_at, archived_at FROM runs WHERE run_id = ?').bind(runId).first();
  if (!row) return null;
  const receipt = observedRun(row), rating = (await ratingsFor(env, [runId])).get(runId);
  try { const artifact = await readArtifact(env, receipt); if (artifact) receipt.artifact = artifact; }
  catch { /* Run receipts remain readable during artifact-store outages. */ }
  const publication = await readPublication(env, receipt);
  if (publication) receipt.publication = publication;
  const review = await readReview(env, receipt);
  if (review) receipt.review = review;
  if (row.archived_at) receipt.archived_at = row.archived_at;
  return withFailureGuidance(rating ? { ...receipt, feedback: rating } : receipt);
}

/**
 * Newest `limit` receipts as briefs (oldest first). Archived runs are left out unless
 * `archived` asks for them alone (newest archived first); get_run still reads any run.
 */
export async function recentRuns(env, { agent, limit = 50, archived = false } = {}) {
  if (!env.DB) return [];
  try {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const where = [archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL', ...(agent ? ['agent = ?'] : [])].join(' AND ');
    const { results } = await env.DB.prepare(`SELECT receipt, updated_at, archived_at FROM runs WHERE ${where} ORDER BY ${archived ? 'archived_at' : 'started'} DESC LIMIT ?`)
      .bind(...(agent ? [agent] : []), n).all();
    const rows = new Map(results.map((x) => [JSON.parse(x.receipt).run_id, x.archived_at]));
    const receipts = results.map((x) => observedRun(x)).reverse();
    const [ratings, extra] = await Promise.all([ratingsFor(env, receipts.map((r) => r.run_id)), publicationsAndReviews(env, receipts)]);
    return receipts.map((r) => {
      const { conversation_id, ...more } = extra.get(r.run_id);
      return { ...runBrief({ ...r, ...more, feedback: ratings.get(r.run_id) }), runner: r.runner,
        ...(conversation_id ? { conversation_id } : {}), ...(rows.get(r.run_id) ? { archived_at: rows.get(r.run_id) } : {}) };
    });
  } catch { return []; } // table missing before migration: behave as before
}

const DAY = 86400000;
/**
 * Finished runs worth archiving, each with the reason shown to the user. Only suggestions: archiving needs the user's
 * click. A whole review conversation is suggested together, so a continuation is never left without its parent.
 */
export function archiveSuggestions(runs, now = Date.now()) {
  const reasons = new Map();
  for (const r of runs) {
    if (['running', 'unknown'].includes(r.status) || r.recovery?.state === 'awaiting_review') continue;
    const reason = ['merged', 'closed'].includes(r.review?.state) ? `PR #${r.review.pr_number} ${r.review.state}`
      : r.recovery?.resumed_by ? 'resumed in a later run'
      : ['failed', 'interrupted'].includes(r.status) && !r.tool_calls ? 'stopped before doing anything'
      : r.feedback && now - Date.parse(r.ended ?? r.started) > 7 * DAY ? 'rated, finished over 7 days ago' : null;
    if (reason) reasons.set(r.run_id, reason);
  }
  const groups = Map.groupBy(runs, (r) => r.conversation_id ?? r.run_id);
  const out = [];
  for (const members of groups.values()) {
    const why = members.map((r) => reasons.get(r.run_id)).find(Boolean);
    // A conversation with active work, or one where only an old member qualifies by age, stays.
    if (!why || members.some((r) => ['running', 'unknown'].includes(r.status) || r.recovery?.state === 'awaiting_review')) continue;
    if (!members.every((r) => reasons.has(r.run_id)) && !/^PR #/.test(why)) continue;
    for (const r of members) out.push({ run_id: r.run_id, reason: reasons.get(r.run_id) ?? why });
  }
  return out;
}

/** Archive or restore finished runs; each item carries the panel's one-time code for that run. */
export async function setArchived(env, { items, archived }, now = new Date()) {
  const ids = [...new Set(items.map((i) => i.run_id))];
  const { results } = await env.DB.prepare(`SELECT run_id, status FROM runs WHERE run_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const status = new Map(results.map((r) => [r.run_id, r.status]));
  const missing = ids.find((id) => !status.has(id));
  if (missing) throw new Error('Unknown run ' + missing);
  if (ids.some((id) => status.get(id) === 'running')) throw new Error('Archive a run after it finishes');
  const done = await redeemCodes(env, 'archive', items.map((i) => [i.confirm, i.run_id]));
  // updated_at moves so the panel's change check notices at once.
  const at = now.toISOString();
  if (done.length) await env.DB.batch(done.map((id) => env.DB.prepare('UPDATE runs SET archived_at = ?, updated_at = ? WHERE run_id = ?').bind(archived ? at : null, at, id)));
  if (done.length < ids.length) throw new Error(`${done.length ? `Updated ${done.length} of ${ids.length} runs. ` : ''}This needs a click in the Agents Hub panel (refresh the panel and try again).`);
  return { archived, run_ids: done };
}

/** Recover a start independently of the short relay-response cache. */
export async function runForRequest(env, requestId) {
  const row = await env.DB.prepare("SELECT receipt, updated_at FROM runs WHERE runner = 'dok' AND json_extract(receipt, '$.request_id') = ? LIMIT 1").bind(requestId).first();
  if (!row) return null;
  const r = observedRun(row);
  return { state: 'started', run_id: r.run_id, runner: 'dok', status: r.status, ...(r.recovery?.resumed_by ? { latest_run_id: r.recovery.resumed_by } : {}) };
}
