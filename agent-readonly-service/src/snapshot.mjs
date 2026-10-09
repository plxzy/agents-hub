import { runBrief, titleOf } from '../../agent-workflow/contract.mjs';

const SECRET_FIELD = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|private[_-]?key|secret|signed[_-]?url)/i;
const SECRET_VALUE = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|private[_-]?key|secret|signed[_-]?url)\s*[:=]|\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}/i;
const SENSITIVE_PATH = /(^|\/)(\.ssh|\.aws|\.config|keychain|cookies?|auth\.json)(\/|$)/i;
const REDACTED = '[redacted: looked like a secret]';

/** True when a value (or any nested key/value) looks like it carries a secret. */
export function containsSecret(value) {
  if (typeof value === 'string') return SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => SECRET_FIELD.test(key) || containsSecret(child));
}

function safeText(value, max = 4000) {
  if (typeof value !== 'string') return undefined;
  const text = containsSecret(value) ? REDACTED : value;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Agent files write lists as `tools: read, bash`; loaders may hand over either form.
const names = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
  .filter((x) => typeof x === 'string').map((x) => x.trim().split('/').pop()).filter(Boolean).slice(0, 50);

/** A run's task is the user's private prompt: publish only its first line, shortened, as a title. */
export function taskTitle(task) {
  if (typeof task !== 'string') return undefined;
  return containsSecret(task) ? REDACTED : titleOf(task);
}

export function sanitizeAgent(agent) {
  if (!agent || typeof agent !== 'object' || typeof agent.name !== 'string') return null;
  const workspace = typeof agent.workspace === 'string' && !SENSITIVE_PATH.test(agent.workspace)
    ? agent.workspace.replace(/^\/Users\/[^/]+/, '~') : undefined;
  return {
    name: safeText(agent.name, 100),
    description: safeText(agent.description, 500),
    model: safeText(agent.model, 100),
    tools: names(agent.tools),
    skills: agent.skills === 'none' ? [] : names(agent.skills),
    guard: safeText(agent.guard ?? undefined, 50),
    workspace,
  };
}

/** A receipt or an already-published brief (the publisher and the Worker both run this, so it must be idempotent). */
export function sanitizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  const b = runBrief({ ...run, title: taskTitle(run.title ?? run.task) });
  const result = {
    ...b, run_id: safeText(b.run_id, 100), agent: safeText(b.agent, 100), kind: safeText(b.kind, 20), status: safeText(b.status, 20),
    started: safeText(b.started, 40), ended: safeText(b.ended, 40), model: safeText(b.model, 100),
  };
  return Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
}

const pendingCounts = (p) => (p && Number.isInteger(p.memory) && Number.isInteger(p.proposals) ? { memory: p.memory, proposals: p.proposals } : null);

/** Builds the public snapshot field by field; anything secret-looking is redacted in place, never published. */
export function sanitizeSnapshot(input) {
  const agents = Array.isArray(input?.agents) ? input.agents.map(sanitizeAgent).filter(Boolean) : [];
  const runs = Array.isArray(input?.runs) ? input.runs.map(sanitizeRun).filter(Boolean).slice(-200) : [];
  const context = Array.isArray(input?.context) ? input.context.filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string').map((x) => ({
    id: x.id, title: safeText(x.title, 200), source: typeof x.source === 'string' ? x.source.slice(0, 100) : 'unknown',
    sequence: Number.isInteger(x.sequence) ? x.sequence : null, updated_at: typeof x.updated_at === 'string' ? x.updated_at : null,
  })).slice(0, 100) : [];
  // Only the number of items waiting for review is published, never their text; null means "not published".
  return { schema_version: 4, generated_at: typeof input?.generated_at === 'string' ? input.generated_at : new Date().toISOString(), agents, runs, context,
    pending: pendingCounts(input?.pending),
    capabilities: { discovery: true, status: true, context: true, run: false, mutate: false } };
}

export function page(items, cursor, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const start = Number.isInteger(Number(cursor)) ? Number(cursor) : 0;
  const data = items.slice(start, start + n);
  return { items: data, next_cursor: start + n < items.length ? String(start + n) : null };
}
