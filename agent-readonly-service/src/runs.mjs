// Run receipts in D1: written by authenticated runners, read by the Hub's MCP tools.
import { containsSecret } from './snapshot.mjs';
import { runBrief, titleOf } from '../../agent-workflow/contract.mjs';
import { ratingsFor } from './decisions.mjs';
import { proposeMemory } from './memory.mjs';

export const RUN_ID = /^r-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const STATUS = ['running', 'completed', 'failed', 'interrupted'];
const KEEP = 1000;
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
  const runtime = r.runtime && typeof r.runtime === 'object' ? Object.fromEntries(['provider', 'model', 'thinking', 'pi_version', 'observed_at']
    .map((k) => [k, short(r.runtime[k], 80)]).filter(([, v]) => v !== undefined)) : undefined;
  const usage = r.usage && typeof r.usage === 'object' ? Object.fromEntries(['input', 'output', 'totalTokens', 'cost']
    .map((k) => [k, num(r.usage[k])]).filter(([, v]) => v !== undefined)) : undefined;
  const out = {
    run_id: r.run_id, agent: r.agent, kind: 'task', runner, status: r.status,
    title: redactLines(titleOf(r.task ?? r.title ?? ''), 200), task: redactLines(r.task, 16000),
    started: iso(r.started), ended: iso(r.ended), model: short(r.model, 100), thinking: short(r.thinking, 20),
    agent_version: short(r.agent_version, 40), commit: /^[a-f0-9]{40,64}$/.test(r.commit ?? '') ? r.commit : undefined,
    tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls.filter((t) => /^[a-z_]{1,40}$/.test(t)).slice(0, 500) : undefined,
    model_calls: Number.isInteger(r.model_calls) && r.model_calls >= 0 ? r.model_calls : undefined,
    accounts_used: Array.isArray(r.accounts_used) ? r.accounts_used.filter((x) => /^openai(-[1-9]\d*)?$/.test(x)).slice(0, 10) : undefined,
    repo: /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(r.repo ?? '') ? r.repo : undefined,
    base_commit: /^[a-f0-9]{40,64}$/.test(r.base_commit ?? '') ? r.base_commit : undefined,
    review_ref: new RegExp(`^refs/heads/review/runs/${r.run_id}$`).test(r.review_ref ?? '') ? r.review_ref : undefined,
    continued_from: RUN_ID.test(r.continued_from ?? '') ? r.continued_from : undefined,
    changed_files: Array.isArray(r.changed_files) ? r.changed_files.filter((f) => typeof f === 'string' && f.length <= 300 && !/[\r\n]/.test(f)).slice(0, 200) : undefined,
    memory_proposed: Number.isInteger(r.memory_proposed) && r.memory_proposed >= 0 && r.memory_proposed <= 20 ? r.memory_proposed : undefined,
    memory_source: ['hub', 'frozen-release'].includes(r.memory_source) ? r.memory_source : undefined,
    memory_hash: /^[a-f0-9]{16}$/.test(r.memory_hash ?? '') ? r.memory_hash : undefined,
    usage, runtime, error: redactLines(r.error, 200), output: redactLines(r.output, 48000),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/** Upsert; a final receipt is never replaced by a late "running" one or by another runner. */
export async function storeRun(env, receipt, runner) {
  if (!env.DB) throw new Error('Run store unavailable');
  const r = sanitizeReceipt(receipt, runner);
  await env.DB.prepare(`INSERT INTO runs (run_id, agent, runner, status, started, ended, updated_at, receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, ended=excluded.ended, updated_at=excluded.updated_at, receipt=excluded.receipt
    WHERE runs.runner = excluded.runner AND (runs.status = 'running' OR excluded.status <> 'running')`)
    .bind(r.run_id, r.agent, runner, r.status, r.started, r.ended ?? null, new Date().toISOString(), JSON.stringify(r)).run();
  await env.DB.prepare('DELETE FROM runs WHERE run_id NOT IN (SELECT run_id FROM runs ORDER BY started DESC LIMIT ?)').bind(KEEP).run();
  // Notes the agent asked to remember become candidates for the user's review (idempotent per run and content).
  if (r.status !== 'running' && Array.isArray(receipt.memory_proposals)) {
    try { await proposeMemory(env, { agent: r.agent, run_id: r.run_id, items: receipt.memory_proposals }); } catch { /* the receipt is stored; the runner retries unreported receipts */ }
  }
  return r;
}

export async function readRun(env, runId) {
  if (!env.DB || !RUN_ID.test(runId ?? '')) return null;
  const row = await env.DB.prepare('SELECT receipt FROM runs WHERE run_id = ?').bind(runId).first();
  if (!row) return null;
  const receipt = JSON.parse(row.receipt), rating = (await ratingsFor(env, [runId])).get(runId);
  return rating ? { ...receipt, feedback: rating } : receipt;
}

/** Newest `limit` receipts as briefs (oldest first, like the snapshot's run list). */
export async function recentRuns(env, { agent, limit = 50 } = {}) {
  if (!env.DB) return [];
  try {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const stmt = agent ? env.DB.prepare('SELECT receipt FROM runs WHERE agent = ? ORDER BY started DESC LIMIT ?').bind(agent, n)
      : env.DB.prepare('SELECT receipt FROM runs ORDER BY started DESC LIMIT ?').bind(n);
    const { results } = await stmt.all();
    const receipts = results.map((x) => JSON.parse(x.receipt)).reverse(), ratings = await ratingsFor(env, receipts.map((r) => r.run_id));
    return receipts.map((r) => ({ ...runBrief({ ...r, feedback: ratings.get(r.run_id) }), runner: r.runner }));
  } catch { return []; } // table missing before migration: behave as before
}

/** Snapshot runs plus Hub runs, deduplicated by id, oldest first. */
export function mergeRuns(snapshotRuns = [], hubRuns = []) {
  const ids = new Set(hubRuns.map((r) => r.run_id));
  return [...snapshotRuns.filter((r) => !ids.has(r.run_id)), ...hubRuns].sort((a, b) => String(a.started).localeCompare(String(b.started)));
}
