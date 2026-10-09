// Public MCP operations are deliberately separate from authenticated host commands.
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$' };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const DEV_OPS = {
  request_development: { description: 'Prepare a dok-dev workflow conversation and request a bounded development grant. The user approves the exact scope in the Development panel. No task starts here.', input: schema({ request_id: id, conversation_id: id }, ['request_id']) },
  get_development: { read: true, description: 'Read your development grants and dok-dev availability; approval credentials are never included.', input: schema({}) },
  start_development_task: { description: 'Run a task or contextual follow-up in an approved dok-dev conversation. The same grant covers unchanged scope until expiry or revocation. Busy submissions are rejected.', input: schema({ request_id: id, grant_id: id, conversation_id: id, task: { type: 'string', minLength: 1, maxLength: 16000 } }) },
  get_development_task: { read: true, description: 'Read a private development task receipt and bounded result.', input: schema({ grant_id: id, run_id: id }) },
  export_development: { description: 'Export a completed task into a private review branch, without merging or activating changes.', input: schema({ request_id: id, grant_id: id, run_id: id }) },
  development_panel: { read: true, appOnly: true, description: 'Load development approval cards for the authenticated user. Private click credentials are returned only in widget metadata.', input: schema({}) },
  decide_development: { appOnly: true, description: 'Approve or revoke only from an explicit user click on the exact development card.', input: schema({ grant_id: id, decision: { type: 'string', enum: ['approve', 'revoke'] }, confirm: { type: 'string', minLength: 72, maxLength: 72 } }) },
};
export const HOST_OPS = {
  dev_prepare: schema({ request_id: id, conversation_id: id }, ['request_id']),
  dev_start: schema({ request_id: id, grant_id: id, conversation_id: id, policy_digest: id, task: { type: 'string', minLength: 1, maxLength: 16000 } }),
  dev_read: schema({ run_id: id }),
  dev_export: schema({ request_id: id, grant_id: id, conversation_id: id, policy_digest: id, run_id: id }),
};
export function validateDevelopment(name, args, host = false) {
  const s = host ? HOST_OPS[name] : DEV_OPS[name]?.input;
  if (!s || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid development operation');
  for (const k of s.required) if (!(k in args)) throw new Error('Missing ' + k);
  for (const [k, v] of Object.entries(args)) {
    const rule = s.properties[k];
    if (!rule || typeof v !== rule.type || rule.enum && !rule.enum.includes(v) || rule.pattern && !new RegExp(rule.pattern).test(v)
      || rule.minLength && v.trim().length < rule.minLength || rule.maxLength && v.length > rule.maxLength) throw new Error('Invalid ' + k);
  }
}
export const developmentTools = () => Object.entries(DEV_OPS).map(([name, op]) => ({ name, description: op.description,
  inputSchema: op.input, annotations: { readOnlyHint: op.read === true, ...(op.read ? {} : { openWorldHint: true }) },
  ...(op.appOnly ? { _meta: { ui: { visibility: ['app'] } } } : {}) }));
