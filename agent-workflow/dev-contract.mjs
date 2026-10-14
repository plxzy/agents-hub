// Public MCP operations are deliberately separate from authenticated host commands.
import { DASHBOARD_URI } from './contract.mjs';
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$' };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const DEV_OPS = {
  request_development: { description: 'Older, approval-gated interactive session on dok-dev for the dev-workflow repo only. For ordinary coding tasks in any repository (dev-workflow, vm, tikkytracker) use start_run instead: it needs no approval and returns a review branch. Use this only when the user explicitly asks for an interactive session. Starts the approval flow. Returns a pending grant and displays its approval card. Wait for the user to click Approve this session, then check get_development and call start_development_task with the grant_id, conversation_id and intended task. No Pi task starts before approval.', input: schema({ request_id: id, conversation_id: id }, ['request_id']) },
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
  // One-shot runs of reviewed read-only agents on a fresh clone; no grant (nothing can be written).
  run_start: schema({ request_id: id, agent: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }, task: { type: 'string', minLength: 1, maxLength: 16000 },
    model: { type: 'string', pattern: '^[a-z0-9-]{1,40}/[A-Za-z0-9._:-]{1,80}$' }, thinking: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    repo: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,63}$' }, continue_from: { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$' },
    pr_number: { type: 'integer', minimum: 1 }, mcp_connection: { type: 'object' } }, ['request_id', 'agent', 'task']),
  run_resume: schema({ run_id: id, request_id: id, checkpoint_version: { type: 'integer', minimum: 1 }, approved: { type: 'boolean' } }, ['run_id', 'request_id', 'checkpoint_version']),
  run_lookup: schema({ target_request_id: id }),
  run_read: schema({ run_id: { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$' } }),
};
export function validateDevelopment(name, args, host = false) {
  const s = host ? HOST_OPS[name] : DEV_OPS[name]?.input;
  if (!s || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid development operation');
  for (const k of s.required) if (!(k in args)) throw new Error('Missing ' + k);
  for (const [k, v] of Object.entries(args)) {
    const rule = s.properties[k];
    if (!rule || (rule.type === 'integer' ? !Number.isSafeInteger(v) || v < (rule.minimum ?? 0) : typeof v !== rule.type) || rule.enum && !rule.enum.includes(v) || rule.pattern && !new RegExp(rule.pattern).test(v)
      || rule.minLength && v.trim().length < rule.minLength || rule.maxLength && v.length > rule.maxLength) throw new Error('Invalid ' + k);
  }
}
export const developmentTools = () => Object.entries(DEV_OPS).map(([name, op]) => ({ name, description: op.description,
  inputSchema: op.input, annotations: { readOnlyHint: op.read === true, ...(op.read ? {} : { openWorldHint: true }) },
  ...(op.appOnly ? { _meta: { ui: { visibility: ['app'] } } }
    : name === 'request_development' ? { _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/outputTemplate': DASHBOARD_URI } } : {}) }));
