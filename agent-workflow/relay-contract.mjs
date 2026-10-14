import { PUBLISH_REVIEW } from './review-publication-contract.mjs';
// Explicit relay surface: no arbitrary shell commands or generic callOp exposed remotely.
const empty = { type: 'object', properties: {}, additionalProperties: false };
const confirm = { type: 'string', pattern: '^[A-Za-z0-9_-]{20,64}$', description: 'One-time code from the panel; only the panel has it.' };
const requestId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,80}$', description: 'Reuse only for the exact same request.' };
export const RELAY_OPS = {
  publish_review: PUBLISH_REVIEW,
  get_remote_run: { title: 'Get a remote run', read: true,
    input: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string', pattern: '^r-[a-zA-Z0-9_-]+$', maxLength: 100 } } },
    description: 'Read status and output of a run started with start_run (same as get_run). Runs are stored in the Hub and readable any time.' },
  panel_data: { title: 'Live agents panel', appOnly: true, read: true, input: empty,
    description: 'Live dashboard data for the user’s panel, including the review queue.' },
  panel_run: { title: 'Run details for the panel', appOnly: true, read: true,
    input: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string', maxLength: 100 } } },
    description: 'Read a run’s full output in the user’s panel.' },
  get_start_status: { title: 'Reconcile a start request', read: true,
    input: { type: 'object', required: ['request_id'], additionalProperties: false, properties: { request_id: requestId } },
    description: 'Read whether the original request reached the runner, without starting work. Unknown does not mean safe to duplicate. After an automatic permission-review timeout, reconcile first; retry the identical request once only if the caller permits it, then ask for guidance. A model change is a different request.' },
  resume_run: { title: 'Resume saved work', read: false,
    input: { type: 'object', required: ['run_id', 'request_id', 'checkpoint_version'], additionalProperties: false,
      properties: { run_id: { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$' }, request_id: requestId,
        checkpoint_version: { type: 'integer', minimum: 1 } } },
    description: 'Resume an eligible failed or interrupted dok run from its exact saved checkpoint, returning a linked new run id. Reuse the request id only for the identical checkpoint. Uncertain file-changing commands require the user to approve recovery in the Hub panel.' },
  decide_recovery: { title: 'Continue inspected work', appOnly: true, read: false,
    input: { type: 'object', required: ['run_id', 'request_id', 'checkpoint_version', 'confirm'], additionalProperties: false,
      properties: { run_id: { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$' }, request_id: requestId,
        checkpoint_version: { type: 'integer', minimum: 1 }, confirm } },
    description: 'Continue from inspected saved files only after the user clicks the exact recovery card. Interrupted commands are recorded as uncertain and are not replayed.' },
  start_run: { title: 'Start an allowed agent', read: false,
    input: { type: 'object', required: ['agent', 'task', 'request_id'], additionalProperties: false, properties: {
      agent: { type: 'string', maxLength: 100 }, task: { type: 'string', minLength: 1, maxLength: 16000 },
      continue: { type: 'boolean' }, request_id: requestId,
      repo: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,63}$', description: 'Repository on dok for agents that are not tied to one (e.g. workflow). Defaults to the agent\u2019s own repository.' },
      continue_from: { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$', description: 'Latest completed run of this agent on the same review conversation, including a no-edit review. Reads its saved review commit, never main. Failed work requires resume_run.' },
      model: { ...{ type: 'string', pattern: '^[a-z0-9-]{1,40}/[A-Za-z0-9._:-]{1,80}$' }, description: 'Optional per-run model override as provider/model, e.g. openai/gpt-6.1-sol. Defaults to the agent definition.' },
      thinking: { ...{ type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }, description: 'Optional per-run thinking level. Defaults to the agent definition.' },
    } }, description: 'Start one of the user\u2019s own Pi agents. Runs on dok, the always-on Linux runner. Read-only agents (helper) get a read-only clone. Agents that change files (see get_status, start_run.runners.dok: e.g. workflow, vm, tikkytracker) work in an isolated writable clone with no network; their changes come back as a saved review, never merged. Configured repositories automatically publish GitHub draft PRs; poll get_run.publication for the URL or blocker. Read get_run first. Follow its next_action: pass continue_from for a completed patch or review, or resume_run for eligible failed work. A run id mentioned only in task text does not attach its files. Never inspect another run by starting a fresh clone; never recreate a saved patch because it is absent from a fresh workspace. Use this (e.g. agent helper) for questions about the user\u2019s repositories instead of delegating to Codex cloud tasks or operating the user\u2019s Mac. Returns run_id at once; poll get_run until the status is no longer running. Optional model (provider/model, e.g. openai/gpt-6.1-sol) and thinking override the agent defaults for this run only. Supply a unique request_id; reuse it only for the exact same request.' },
  rate_run: { title: 'Rate a run', appOnly: true, read: false,
    input: { type: 'object', required: ['run_id', 'rating', 'request_id', 'confirm'], additionalProperties: false, properties: {
      run_id: { type: 'string', maxLength: 100 }, rating: { type: 'string', enum: ['good', 'bad'] }, comment: { type: 'string', maxLength: 4000 }, request_id: requestId, confirm,
    } }, description: 'Record a rating only from the user’s explicit click in the panel.' },
  review_decide: { title: 'Review a proposal', appOnly: true, read: false,
    input: { type: 'object', required: ['id', 'decision', 'request_id', 'confirm'], additionalProperties: false, properties: {
      id: { type: 'string', maxLength: 120 }, decision: { type: 'string', enum: ['accept', 'reject'] }, reason: { type: 'string', maxLength: 4000 }, request_id: requestId, confirm,
    } }, description: 'Accept or reject a proposal only from the user’s explicit click in the panel.' },
};
export function validateRelay(name, args) {
  const op = Object.hasOwn(RELAY_OPS, name) ? RELAY_OPS[name] : undefined;
  if (!op || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid relay operation');
  for (const key of op.input.required ?? []) if (!(key in args)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = op.input.properties[key];
    // The local Mac adapter may attach a bounded initialize observation to a dok start.
    // It is internal metadata, never part of the public start_run tool schema.
    if (name === 'start_run' && key === 'mcp_connection' && value && typeof value === 'object' && !Array.isArray(value)) continue;
    if (!rule || (rule.type === 'integer' ? !Number.isSafeInteger(value) || value < (rule.minimum ?? 0) : typeof value !== rule.type) || (rule.enum && !rule.enum.includes(value))
      || (rule.minLength && value.trim().length < rule.minLength) || (rule.maxLength && value.length > rule.maxLength)
      || (rule.pattern && !new RegExp(rule.pattern).test(value))) throw new Error(`Invalid ${key}`);
  }
}
export const relayToolList = () => Object.entries(RELAY_OPS).map(([name, op]) => ({
  name, title: op.title, description: op.description, inputSchema: op.input,
  annotations: { readOnlyHint: op.read, ...(op.read ? {} : { openWorldHint: true }) },
  ...(op.appOnly ? { _meta: { ui: { visibility: ['app'] } } } : {}),
}));
