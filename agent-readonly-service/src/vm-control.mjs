// Hub Worker side of VM worker control (plxzy/vm#806). A thin caller: it validates the request, forwards it over the
// authenticated runner relay to the dok supervisor, and returns what the supervisor answers. The Hub owns no worker, job,
// history or dedupe authority and stores nothing: the supervisor's grants and durable intent record decide everything,
// and vmservice stays the lifecycle authority. Off unless VM_CONTROL_ENABLED is 'true', and even then deny by default.
import { validateRelay } from '../../agent-workflow/relay-contract.mjs';
import { ContractError, validateIntent } from '../../agent-workflow/vm-control-contract.mjs';

/** The principal the runner's grants and request keys are scoped to: one stable, non-PII id per Access-verified user,
 *  `hub:` + 32 hex of SHA-256("agents-hub:vm-control:v1:" + Access subject). The owner approves grants for this value. It
 *  is derived only from the verified subject, so a tool argument can never set it and one user's grant never serves another. */
export async function vmControlPrincipal(owner) {
  if (typeof owner !== 'string' || !owner) throw new Error('VM control needs an authenticated user');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('agents-hub:vm-control:v1:' + owner));
  return 'hub:' + Array.from(new Uint8Array(digest).subarray(0, 16), n => n.toString(16).padStart(2, '0')).join('');
}
export const vmControlEnabled = env => Boolean(env.DOK_RELAY_TOKEN && env.RELAY && env.DEVELOPMENT_ENABLED === 'true' && env.VM_CONTROL_ENABLED === 'true');

async function call(env, operation, args) {
  if (!vmControlEnabled(env)) throw new Error('VM control is unavailable');
  // No request_id: the relay then gives every dispatch its own id. Dedupe belongs to the supervisor's durable request key,
  // so a cached relay result can never stand in for a fresh read.
  const result = await env.RELAY.getByName('owner-dok-dev').dispatch(operation, args);
  if (result.ok) return result.value;
  // The relay's own wording tells the caller to reuse a relay id that does not exist here.
  if (result.kind === 'transport') throw new Error('Relay response unavailable; the control request may have reached the runner. Repeat the SAME request_key (or ask get_vm_control with the mutation_id) to read its outcome; never use a new key for the same action.');
  throw new Error(result.error);
}

export async function submitVmControl(env, owner, args) {
  const principal = await vmControlPrincipal(owner);
  validateRelay('submit_vm_control', args);
  // Strict intent validation here too, so a malformed request never occupies the runner's ordered command queue.
  let intent;
  try { intent = validateIntent(args.intent); }
  catch (e) { throw new Error(e instanceof ContractError ? `Invalid intent: ${e.detail}` : 'Invalid intent'); }
  return call(env, 'vm_control_submit', { principal, request_key: args.request_key, intent });
}

export async function getVmControl(env, owner, args) {
  const principal = await vmControlPrincipal(owner);
  validateRelay('get_vm_control', args);
  return call(env, 'vm_control_get', { principal, mutation_id: args.mutation_id, ...(args.refresh === undefined ? {} : { refresh: args.refresh }) });
}
