import { publicReview } from './run-continuation.mjs';
import { publicPublication } from './review-publication-contract.mjs';
// The data contract every Agents Hub surface shares: the read operations' names, descriptions and input schemas,
// and the shapes their results have. The local catalog (ops.mjs) answers them from this Mac; the hosted hub
// (agent-readonly-service) answers the same operations from its D1 store. Pure JavaScript, no Node
// APIs, so the Worker bundles this file too.
//
// Shapes (both surfaces):
//   run brief   { run_id, agent, kind, status, title, started, ended, model, tool_calls: n, blocked: n, tokens, cost_usd, feedback }
//               local briefs add `task` (the full prompt); the hosted hub never has it.
//   dashboard   { generated_at, capabilities, status, agents, runs: brief[], pending: item[] | null }
//               status.pending is { memory, proposals } or null when unknown.
//   health      additive field on get_status/open_dashboard: health.mjs schema_version 1. Legacy fields and tool names
//               remain unchanged. `capabilities` describe the surface, never live relay authority.
//   get_run     the run itself (local and hosted: the stored receipt).
//               Hub completed review runs add `artifact` after private bundle publication, with version,
//               run_id, repo, commit, base_commit, review_ref, bundle_ref, size and sha256.

import { publicRecovery } from './recovery-contract.mjs';
import { sanitizeProgress } from './run-progress.mjs';

export const DASHBOARD_URI = 'ui://agents-hub/dashboard-v14.html';
/** Any earlier dashboard URI a host may still have cached; it is answered with the current page. */
export const isDashboardUri = (uri) => typeof uri === 'string' && /^ui:\/\/agents(-hub)?\/dashboard(-v\d+)?\.html$/.test(uri);

// MCP Extensions: the same app opens from navigation or beside a conversation, without a model call.
// https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#mcp-app-entrypoints
export const DASHBOARD_TOOL_META = {
  ui: { resourceUri: DASHBOARD_URI },
  'openai/outputTemplate': DASHBOARD_URI,
  'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
};
export const DASHBOARD_RESOURCE_META = {
  ui: { prefersBorder: true },
  'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
};
export const DASHBOARD_ICONS = [{
  src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M7 3v14M7 8h11"/></svg>'),
  mimeType: 'image/svg+xml', sizes: ['20x20'],
}];

const count = (v) => (Array.isArray(v) ? v.length : Number.isInteger(v) && v >= 0 ? v : 0);
const num = (...vs) => vs.find((v) => Number.isFinite(v));

/** A short one-line title for a task: first line, at most 120 characters. */
export function titleOf(text) {
  if (typeof text !== 'string') return undefined;
  const line = text.trim().split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** A run receipt (or an already-made brief: this is idempotent) as the shared brief, without the full task. */
export function runBrief(r) {
  const rating = typeof r.feedback === 'string' ? r.feedback : r.feedback?.rating;
  return {
    ...(publicReview(r.review) ? { review: publicReview(r.review) } : {}),
    ...(publicPublication(r.publication) ? { publication: publicPublication(r.publication) } : {}),
    run_id: r.run_id, agent: r.agent, kind: r.kind ?? 'task', status: r.status, title: r.title ?? titleOf(r.task),
    started: r.started, ended: r.ended, model: r.model, tool_calls: count(r.tool_calls), blocked: count(r.blocked),
    tokens: num(r.usage?.totalTokens, r.tokens), cost_usd: num(r.usage?.cost, r.cost_usd),
    ...(publicRecovery(r.recovery) ? { recovery: { ...publicRecovery(r.recovery), inspection: undefined } } : {}),
    feedback: rating === 'good' || rating === 'bad' ? rating : null,
    ...(['running', 'unknown'].includes(r.status) && sanitizeProgress(r.progress) ? { progress: sanitizeProgress(r.progress) } : {}),
  };
}

/** Each agent's latest run, as the dashboard's agent list shows it. */
export const lastRunOf = (name, runs) => {
  const last = runs.filter((r) => r.agent === name).at(-1);
  return last ? { run_id: last.run_id, status: last.status, started: last.started } : null;
};

export function dashboardSummary(d) {
  const p = d.status.pending;
  const knownReview = Number.isInteger(p?.memory) && p.memory >= 0 && Number.isInteger(p?.proposals) && p.proposals >= 0;
  const review = knownReview ? `${p.memory} memory note(s) and ${p.proposals} proposal(s) waiting for review` : 'review queue not published/unknown';
  const fresh = d.snapshot ? ` · snapshot ${d.snapshot.generated_at ?? 'time unknown'}${d.snapshot.stale ? ' (stale/unavailable)' : ''}` : '';
  const relay = d.health ? ` · relay ${d.health.relay.state} · remote execution ${d.health.execution.enabled === null ? 'unknown' : d.health.execution.enabled ? 'enabled' : 'deliberately off'}` : '';
  return `${d.status.agents ?? 'unknown'} agents · ${d.status.running ?? 'unknown'} running · ${review} · last run: `
    + `${d.status.last_run ? `${d.status.last_run.agent} ${d.status.last_run.status}` : 'unknown/none recorded'}${fresh}${relay}`;
}

const NONE = { type: 'object', properties: {}, additionalProperties: false };

/** The read operations both surfaces offer, by name. Each surface adds its own `run`. */
export const READ_OPS = {
  open_dashboard: {
    title: 'Agents Hub dashboard', ui: DASHBOARD_URI, input: NONE, annotations: { readOnlyHint: true },
    description: 'Open the interactive Agents Hub dashboard: agents, recent runs and what waits for the user\'s review; '
      + 'where running is allowed, also a form to start a run. Use when the user wants to see, check on or manage their agents.',
    summary: dashboardSummary,
  },
  get_status: {
    title: 'Agents status', input: NONE, annotations: { readOnlyHint: true },
    description: 'Read-only counts and one-shot health observations: relay state, snapshot freshness, remote execution and allowlist information when available. Unknown values remain unknown; historical success is not a heartbeat.',
  },
  list_agents: {
    title: 'List agents', input: NONE, annotations: { readOnlyHint: true },
    description: "List the user's agents (name, what it is for, tools, skills, guard, workspace, last run).",
  },
  list_runs: {
    title: 'List runs', annotations: { readOnlyHint: true },
    description: 'Recent agent runs and chats (newest last), with status, title, cost and the user\'s rating. Includes runs in progress.',
    input: { type: 'object', additionalProperties: false, properties: {
      agent: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    } },
  },
  get_run: {
    title: 'Get a run', annotations: { readOnlyHint: true },
    description: 'One run by id. A run still in progress has status running. Completed review runs may include artifact metadata for authenticated Mac import through tools/run-artifact/import.mjs; publication reports GitHub draft PR delivery separately from coding completion. Poll publication until published or blocked.',
    input: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string' } } },
  },
};
