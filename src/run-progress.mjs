const PHASES = ['startup', 'model', 'tool', 'export'];
const ACTIONS = ['preparing', 'model_started', 'model_streaming', 'message_completed', 'tool_started', 'tool_running', 'tool_completed', 'tool_error', 'model_error', 'export_started'];
const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const safeName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : undefined;

export function sanitizeProgress(value) {
  if (!value || !PHASES.includes(value.phase) || !ACTIONS.includes(value.action) || !iso(value.observed_at)) return undefined;
  return Object.fromEntries(Object.entries({ phase: value.phase, action: value.action, observed_at: iso(value.observed_at), last_tool: safeName(value.last_tool) }).filter(([, item]) => item !== undefined));
}

export function progressSummary(run = {}) {
  const progress = sanitizeProgress(run.progress);
  return progress ? `${progress.phase}: ${progress.action.replaceAll('_', ' ')}` : '';
}
