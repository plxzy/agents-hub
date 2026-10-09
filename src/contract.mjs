// Public read-only contract shared by the dashboard and adapters.
export const READ_OPS = {
  open_dashboard: { title: 'Agent dashboard', annotations: { readOnlyHint: true } },
  get_status: { title: 'Agent status', annotations: { readOnlyHint: true } },
  list_agents: { title: 'List agents', annotations: { readOnlyHint: true } },
  list_runs: { title: 'List runs', annotations: { readOnlyHint: true } },
  get_run: { title: 'Get a run', annotations: { readOnlyHint: true } },
};

export const titleOf = (text) => {
  if (typeof text !== 'string') return undefined;
  const line = text.trim().split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

const count = value => Array.isArray(value) ? value.length : Number.isInteger(value) && value >= 0 ? value : 0;
const number = (...values) => values.find(value => Number.isFinite(value));

export function runBrief(run = {}) {
  return {
    run_id: run.run_id,
    agent: run.agent,
    kind: run.kind ?? 'task',
    status: run.status,
    title: run.title ?? titleOf(run.task),
    started: run.started,
    ended: run.ended,
    model: run.model,
    tool_calls: count(run.tool_calls),
    blocked: count(run.blocked),
    tokens: number(run.usage?.totalTokens, run.tokens),
    cost_usd: number(run.usage?.cost, run.cost_usd),
    feedback: ['good', 'bad'].includes(run.feedback) ? run.feedback : null,
    ...(run.progress ? { progress: run.progress } : {}),
  };
}

export function dashboardSummary(data = {}) {
  const status = data.status ?? {};
  const pending = status.pending;
  const review = Number.isInteger(pending?.proposals) ? `${pending.proposals} waiting for review` : 'review count unknown';
  return `${status.agents ?? 'unknown'} agents · ${status.running ?? 'unknown'} running · ${review}`;
}
