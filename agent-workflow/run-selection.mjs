// Small shared contract for explicit starts. No credentials or runtime imports.
export const SELECTION_VERSION = 1;
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const field = (type, rest = {}) => ({ type, ...rest });
export const SELECTED_START_INPUT = {
  type: 'object', additionalProperties: false, required: ['runner', 'agent', 'task', 'request_id'],
  properties: {
    runner: field('string', { enum: ['mac', 'dok'] }),
    agent: field('string', { pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }),
    task: field('string', { minLength: 1, maxLength: 16000 }),
    request_id: field('string', { pattern: REQUEST_ID.source }),
    cwd: field('string'), continue: field('boolean'),
  },
};
export function validateSelectedStart(args, macRoute = false) {
  const schema = SELECTED_START_INPUT;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid start request');
  const required = macRoute ? ['agent', 'task', 'request_id'] : schema.required;
  for (const k of required) if (!Object.hasOwn(args, k)) throw new Error(`Missing ${k}`);
  for (const [k, v] of Object.entries(args)) {
    const rule = schema.properties[k];
    if (!rule || macRoute && !required.includes(k) || typeof v !== rule.type || rule.enum && !rule.enum.includes(v)
      || rule.pattern && !new RegExp(rule.pattern).test(v) || rule.minLength && v.trim().length < rule.minLength
      || rule.maxLength && v.length > rule.maxLength) throw new Error(`Invalid ${k}`);
  }
  if (args.runner === 'dok' && ('cwd' in args || 'continue' in args)) throw new Error('dok does not accept Mac directory or continuation fields');
}
export function dokTarget(status, summaries = []) {
  const compatible = status?.run_selection?.version === SELECTION_VERSION;
  const available = status?.online === true && status?.enabled === true && compatible;
  const reason = status?.available === false ? 'dok is disabled or its status is unavailable.'
    : !status?.online ? 'dok is offline.' : !status.enabled ? 'dok starts are disabled.'
      : !compatible ? 'dok needs the runner-selection update.' : null;
  const agents = (status?.run_selection?.agents ?? []).filter(a => status.agents.includes(a.name)).map(a => ({
    ...summaries.find(s => s.name === a.name), ...a,
  }));
  return { id: 'dok', label: 'dok', available, reason, agents };
}
