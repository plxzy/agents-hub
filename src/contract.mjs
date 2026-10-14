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
    ...(typeof run.conversation_id === 'string' ? { conversation_id: run.conversation_id } : {}),
    ...(reviewOf(run.review) ? { review: reviewOf(run.review) } : {}),
    ...(typeof run.archived_at === 'string' ? { archived_at: run.archived_at } : {}),
  };
}

// A run's pull request, reduced to what the list shows.
function reviewOf(review) {
  return Number.isInteger(review?.pr_number) && ['open', 'closed', 'merged'].includes(review.state) ? { pr_number: review.pr_number, state: review.state } : undefined;
}

const active = run => ['running', 'unknown'].includes(run.status);
const newest = (a, b) => String(b.started).localeCompare(String(a.started));

/** Runs that continue one review share a conversation: newest conversation first, newest run first inside it. */
export function conversations(runs = []) {
  const groups = new Map();
  for (const run of runs) {
    const key = run.conversation_id ?? run.run_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups].map(([key, members]) => ({ key, members: members.sort(newest) })).sort((a, b) => newest(a.members[0], b.members[0]));
}

/**
 * Finished runs worth archiving, each with a reason the user can read. Archiving stays the user's decision.
 * A whole review conversation is suggested together, so a continuation never loses its parent.
 */
export function archiveSuggestions(runs = [], now = Date.now()) {
  const reasonFor = run => run.review && ['merged', 'closed'].includes(run.review.state) ? `PR #${run.review.pr_number} ${run.review.state}`
    : ['failed', 'interrupted'].includes(run.status) && !run.tool_calls ? 'stopped before doing anything'
    : run.feedback && now - Date.parse(run.ended ?? run.started) > 7 * 86_400_000 ? 'rated, finished over 7 days ago' : null;
  const out = [];
  for (const { members } of conversations(runs.filter(run => !run.archived_at))) {
    if (members.some(active)) continue;
    const reasons = members.map(reasonFor), pr = reasons.find(reason => reason?.startsWith('PR #'));
    if (!pr && reasons.some(reason => !reason)) continue;
    members.forEach((run, i) => out.push({ run_id: run.run_id, reason: reasons[i] ?? pr }));
  }
  return out;
}

export function dashboardSummary(data = {}) {
  const status = data.status ?? {};
  const pending = status.pending;
  const review = Number.isInteger(pending?.proposals) ? `${pending.proposals} waiting for review` : 'review count unknown';
  return `${status.agents ?? 'unknown'} agents · ${status.running ?? 'unknown'} running · ${review}`;
}
