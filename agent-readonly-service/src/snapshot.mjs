const SECRET_FIELD = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|private[_-]?key|secret|signed[_-]?url)/i;
const SECRET_VALUE = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|private[_-]?key|secret|signed[_-]?url)\s*[:=]/i;
const SENSITIVE_PATH = /(^|\/)(\.ssh|\.aws|\.config|keychain|cookies?|auth\.json)(\/|$)/i;
function containsSecretField(value) {
  if (typeof value === 'string') return SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => SECRET_FIELD.test(key) || containsSecretField(child));
}

function safeText(value) {
  if (typeof value !== 'string') return undefined;
  return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
}

export function sanitizeAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  return {
    name: safeText(agent.name),
    description: safeText(agent.description),
    model: safeText(agent.model),
    tools: Array.isArray(agent.tools) ? agent.tools.filter((x) => typeof x === 'string').slice(0, 50) : [],
    skills: Array.isArray(agent.skills) ? agent.skills.filter((x) => typeof x === 'string').map((x) => x.split('/').pop()).slice(0, 50) : [],
    guard: safeText(agent.guard),
    workspace: safeText(agent.workspace)?.replace(/^\/Users\/[^/]+/, '~'),
  };
}

export function sanitizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  const result = {
    run_id: safeText(run.run_id), agent: safeText(run.agent), kind: safeText(run.kind ?? 'task'),
    status: safeText(run.status), task: safeText(run.task), started: safeText(run.started),
    finished: safeText(run.finished), model: safeText(run.model), tool_calls: Array.isArray(run.tool_calls) ? run.tool_calls.length : 0,
    blocked: Array.isArray(run.blocked) ? run.blocked.length : 0, tokens: Number.isFinite(run.usage?.totalTokens) ? run.usage.totalTokens : undefined,
    cost_usd: Number.isFinite(run.usage?.cost) ? run.usage.cost : undefined, feedback: run.feedback?.rating === 'good' || run.feedback?.rating === 'bad' ? run.feedback.rating : null,
  };
  return Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
}

export function sanitizeSnapshot(input) {
  const paths = (input?.agents ?? []).map((x) => x?.workspace).filter((x) => typeof x === 'string');
  if (containsSecretField(input) || paths.some((x) => SENSITIVE_PATH.test(x))) throw new Error('snapshot contains a disallowed secret or sensitive path');
  const agents = Array.isArray(input?.agents) ? input.agents.map(sanitizeAgent).filter(Boolean) : [];
  const runs = Array.isArray(input?.runs) ? input.runs.map(sanitizeRun).filter(Boolean).slice(-200) : [];
  const context = Array.isArray(input?.context) ? input.context.filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string').map((x) => ({
    id: x.id, title: x.title.slice(0, 200), source: typeof x.source === 'string' ? x.source.slice(0, 100) : 'unknown',
    sequence: Number.isInteger(x.sequence) ? x.sequence : null, updated_at: typeof x.updated_at === 'string' ? x.updated_at : null,
  })).slice(0, 100) : [];
  return { schema_version: 1, generated_at: typeof input?.generated_at === 'string' ? input.generated_at : new Date().toISOString(), agents, runs, context,
    capabilities: { discovery: true, status: true, context: true, execute: false, mutate: false } };
}

export function page(items, cursor, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const start = Number.isInteger(Number(cursor)) ? Number(cursor) : 0;
  const data = items.slice(start, start + n);
  return { items: data, next_cursor: start + n < items.length ? String(start + n) : null };
}
