// The data contract every Agents Hub surface shares: the read operations' names, descriptions and input schemas,
// and the shapes their results have. The local catalog (ops.mjs) answers them from this Mac; the hosted hub
// (agent-readonly-service) answers the same operations from the last published snapshot. Pure JavaScript, no Node
// APIs, so the Worker bundles this file too.
//
// Shapes (both surfaces):
//   run brief   { run_id, agent, kind, status, title, started, ended, model, tool_calls: n, blocked: n, tokens, cost_usd, feedback }
//               local briefs add `task` (the full prompt); the hosted hub never has it.
//   dashboard   { generated_at, capabilities, status, agents, runs: brief[], pending: item[] | null, snapshot? }
//               status.pending is { memory, proposals } or null when unknown. `snapshot` is present only on the
//               hosted hub: { published_at, generated_at, stale }.
//   get_run     the run itself (local: the full receipt; hosted: its brief), plus `snapshot` on the hosted hub.

export const DASHBOARD_URI = 'ui://agents-hub/dashboard.html';

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
    run_id: r.run_id, agent: r.agent, kind: r.kind ?? 'task', status: r.status, title: r.title ?? titleOf(r.task),
    started: r.started, ended: r.ended, model: r.model, tool_calls: count(r.tool_calls), blocked: count(r.blocked),
    tokens: num(r.usage?.totalTokens, r.tokens), cost_usd: num(r.usage?.cost, r.cost_usd),
    feedback: rating === 'good' || rating === 'bad' ? rating : null,
  };
}

/** Each agent's latest run, as the dashboard's agent list shows it. */
export const lastRunOf = (name, runs) => {
  const last = runs.filter((r) => r.agent === name).at(-1);
  return last ? { run_id: last.run_id, status: last.status, started: last.started } : null;
};

export function dashboardSummary(d) {
  const p = d.status.pending;
  const review = p ? `${p.memory} memory note(s) and ${p.proposals} proposal(s) waiting for review` : 'review queue not published';
  const fresh = d.snapshot ? ` · snapshot ${d.snapshot.generated_at}${d.snapshot.stale ? ' (stale)' : ''}` : '';
  return `${d.status.agents} agents · ${d.status.running} running · ${review} · last run: `
    + `${d.status.last_run ? `${d.status.last_run.agent} ${d.status.last_run.status}` : 'none'}${fresh}`;
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
    description: 'Counts of agents and runs, runs in progress, and how many items wait for the user\'s review.',
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
    description: 'One run by id. A run still in progress has status running.',
    input: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string' } } },
  },
};
