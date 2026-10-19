import { PUBLISH_REVIEW } from './review-publication-contract.mjs';
// Explicit relay surface: no arbitrary shell commands or generic callOp exposed remotely.
const empty = { type: 'object', properties: {}, additionalProperties: false };
const confirm = { type: 'string', pattern: '^[A-Za-z0-9_-]{20,64}$', description: 'One-time code from the panel; only the panel has it.' };
const requestId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,80}$', description: 'Reuse only for the exact same request.' };
const runId = { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$' };
// Operator actions on one dok run. Each returns a receipt (action_id, before, after) that list_run_actions reads back.
const control = (title, description) => ({ title, read: false,
  input: { type: 'object', required: ['run_id', 'request_id'], additionalProperties: false, properties: { run_id: runId, request_id: requestId,
    reason: { type: 'string', pattern: '^[A-Za-z0-9 ;:.,_-]{0,120}$', description: 'Short reason recorded with the action (letters, digits, spaces and ;:.,_- only).' } } },
  description: description + ' Returns {action_id, run_id, action, before, after}; the action is recorded and readable with list_run_actions.' });
export const RUN_CONTROLS = { cancel_run: 'cancel', pause_run: 'pause', dismiss_run: 'dismiss', retry_inspection: 'retry_inspection' };
export const RELAY_OPS = {
  publish_review: PUBLISH_REVIEW,
  get_remote_run: { title: 'Get a remote run', read: true,
    input: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string', pattern: '^r-[a-zA-Z0-9_-]+$', maxLength: 100 } } },
    description: 'Read status and output of a run started with start_run (same as get_run). Runs are stored in the Hub and readable any time.' },
  panel_data: { title: 'Live agents panel', appOnly: true, read: true,
    input: { type: 'object', additionalProperties: false, properties: { since: { type: 'string', pattern: '^[a-f0-9]{16}$' } } },
    description: 'Live dashboard data for the user’s panel, including the review queue. With since (the last version), returns only {unchanged, version} when nothing changed.' },
  panel_run: { title: 'Run details for the panel', appOnly: true, read: true,
    input: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string', maxLength: 100 } } },
    description: 'Read a run’s full output in the user’s panel.' },
  panel_archived: { title: 'Archived runs for the panel', appOnly: true, read: true, input: empty,
    description: 'Runs the user archived from the panel, newest first, so the panel can list and restore them.' },
  archive_runs: { title: 'Archive or restore runs', appOnly: true, read: false,
    input: { type: 'object', required: ['items', 'archived', 'request_id'], additionalProperties: false, properties: {
      items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['run_id', 'confirm'], additionalProperties: false,
        properties: { run_id: { type: 'string', pattern: '^[rc]-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$' }, confirm } } },
      archived: { type: 'boolean', description: 'true hides the runs from the panel; false restores them.' }, request_id: requestId,
    } }, description: 'Archive or restore finished runs only from the user’s explicit click in the panel. Archived runs stay readable with get_run.' },
  get_start_status: { title: 'Reconcile a start request', read: true,
    input: { type: 'object', required: ['request_id'], additionalProperties: false, properties: { request_id: requestId } },
    description: 'Read whether the original request reached the runner, without starting work. Unknown does not mean safe to duplicate. After an automatic permission-review timeout, reconcile first; retry the identical request once only if the caller permits it, then ask for guidance. A model change is a different request.' },
  resume_run: { title: 'Resume saved work', read: false,
    input: { type: 'object', required: ['run_id', 'request_id', 'checkpoint_version'], additionalProperties: false,
      properties: { run_id: { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$' }, request_id: requestId,
        checkpoint_version: { type: 'integer', minimum: 1 } } },
    description: 'Resume an eligible failed or interrupted dok run from its exact saved checkpoint, returning a linked new run id. Reuse the request id only for the identical checkpoint. Uncertain file-changing commands require the user to approve recovery in the Hub panel.' },
  cancel_run: control('Cancel a run', 'Stop one active dok run now. Its files are kept as an interrupted run that is never resumed automatically; dismiss_run then releases its conversation.'),
  pause_run: control('Pause a run', 'Stop one active dok run at its latest checkpoint and hold it. Nothing resumes it automatically; resume_run with its checkpoint_version continues it.'),
  dismiss_run: control('Dismiss a stopped run', 'Give up on a failed or interrupted dok run that will not be recovered, for example after its work was redone. Nothing is deleted: its workspace and checkpoint stay for inspection, and its review conversation is no longer blocked.'),
  retry_inspection: control('Retry a recovery inspection', 'Run the read-only recovery inspection again for an interrupted dok run whose inspection failed, so the user can decide in the panel.'),
  list_run_actions: { title: 'List actions on a run', read: true,
    input: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: runId } },
    description: 'Operator actions recorded for a run (cancel, pause, dismiss, retry_inspection), oldest first, each with its caller and the run state before and after.' },
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
      pr_number: { type: 'integer', minimum: 1, description: 'Existing Hub-linked PR in repo. Continue its current GitHub head, including reviewer fixes. Mutually exclusive with continue_from.' },
      issue_number: { type: 'integer', minimum: 1, description: 'GitHub issue in repo this work addresses. Recorded on the run, inherited by follow-ups, and referenced in the draft PR the Hub opens.' },
      continue_from: { type: 'string', pattern: '^r-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$', description: 'Latest completed run of this agent on the same review conversation, including a no-edit review. Published reviews start from the current PR head; internal reviews use their saved commit. Failed work requires resume_run.' },
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
  // VM worker control (plxzy/vm#806). Listed to clients only when the Worker has VM_CONTROL_ENABLED; authority is the
  // runner's own enrollment and grants (deny by default), never these arguments. Contract: vm docs/AGENTS-HUB-VMSERVICE-CONTRACT.md.
  submit_vm_control: { title: 'Submit a VM worker control intent', read: false,
    input: { type: 'object', required: ['request_key', 'intent'], additionalProperties: false, properties: {
      request_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$', description: 'One per user action. Reuse it only for the exact same intent: a repeat reads the original outcome and sends nothing.' },
      intent: { type: 'object', additionalProperties: false, required: ['format', 'operation', 'target', 'hostId', 'service', 'projectId', 'worker', 'workerGeneration', 'backingId'],
        properties: { format: { const: 1 }, operation: { enum: ['start', 'stop', 'restart'] }, target: { enum: ['backing', 'browser'] },
          hostId: { type: 'string', minLength: 1, maxLength: 200 }, service: { type: 'string', minLength: 1, maxLength: 200 }, projectId: { type: 'string', minLength: 1, maxLength: 200 },
          worker: { type: 'string', minLength: 1, maxLength: 200 }, workerGeneration: { type: 'string', minLength: 1, maxLength: 200 },
          backingId: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 12, maxLength: 64, pattern: '^[0-9a-f]+$' }], description: 'Required. null means the service observed no backing; it is never a default.' } } } } },
    description: 'Ask the runner to run one VM worker control action (target backing or browser; start, stop or restart; backing restart is not offered). Needs a project the owner enrolled and an approved grant, otherwise it is refused before anything is sent. The intent must come from a fresh service observation. Returns {response, view}: response.state is confirmed, refused, unknown or absent and carries its provenance; unknown is not failed and not permission to retry. If the call returns {status: "in-flight"} or the reply is lost, repeat the SAME request_key; never use a new key for the same action. A browser action is not a VM action.' },
  get_vm_control: { title: 'Read a VM worker control receipt', read: true,
    input: { type: 'object', required: ['mutation_id'], additionalProperties: false, properties: {
      mutation_id: { type: 'string', pattern: '^vmc-[0-9a-f]{32}$', description: 'From the response.request of submit_vm_control.' },
      refresh: { type: 'boolean', description: 'true asks the service for one bounded receipt read now. It never resends the action. Default: the runner’s recorded state, no service contact.' } } },
    description: 'Read the recorded outcome of one VM control intent, with provenance and freshness. Receipt confirmation is not current worker health. Needs a read grant. Returns {response, view}, or {status: "in-flight"} while a refresh is still running.' },
};
export function validateRelay(name, args) {
  const op = Object.hasOwn(RELAY_OPS, name) ? RELAY_OPS[name] : undefined;
  if (!op || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid relay operation');
  if (name === 'start_run' && args.pr_number !== undefined && args.continue_from !== undefined) throw Error('Select pr_number or continue_from');
  for (const key of op.input.required ?? []) if (!(key in args)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = op.input.properties[key];
    // The local Mac adapter may attach a bounded initialize observation to a dok start.
    // It is internal metadata, never part of the public start_run tool schema.
    if (name === 'start_run' && key === 'mcp_connection' && value && typeof value === 'object' && !Array.isArray(value)) continue;
    if (rule?.type === 'array') {
      if (!Array.isArray(value) || value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity)) throw new Error(`Invalid ${key}`);
      for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((k) => !Object.hasOwn(rule.items.properties, k))) throw new Error(`Invalid ${key}`);
        for (const [k, rule2] of Object.entries(rule.items.properties)) {
          if (typeof item[k] !== rule2.type || (rule2.pattern && !new RegExp(rule2.pattern).test(item[k]))) throw new Error(`Invalid ${key}`);
        }
      }
      continue;
    }
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
