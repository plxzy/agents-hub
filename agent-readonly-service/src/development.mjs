import { validateDevelopment } from '../../agent-workflow/dev-contract.mjs';
import { fingerprint } from '../../agent-workflow/relay-wire.mjs';
export const dokRelay = env => env.RELAY.getByName('owner-dok-dev');

export async function developmentCall(env, owner, operation, args) {
  validateDevelopment(operation, args);
  if (!owner || !env.DOK_RELAY_TOKEN || env.DEVELOPMENT_ENABLED !== 'true') throw new Error('Development sessions are unavailable');
  const host = dokRelay(env);
  const dispatch = async (op, input) => { const r = await host.dispatch(op, input); if (!r.ok) throw new Error(r.error); return r.value; };
  if (operation === 'get_development' || operation === 'development_panel') return host.developmentPanel(owner, operation === 'development_panel');
  if (operation === 'decide_development') return host.developmentDecide(owner, args.grant_id, args.decision, args.confirm);
  if (operation === 'request_development') {
    const fp = await fingerprint(operation, args);
    const previous = await host.developmentPrevious(owner, args.request_id, fp);
    if (previous) return previous;
    const manifest = await dispatch('dev_prepare', args);
    return host.developmentRequest(owner, args.request_id, fp, manifest);
  }
  const grant = await host.developmentGet(owner, args.grant_id);
  if (operation === 'get_development_task') {
    const r = await dispatch('dev_read', { run_id: args.run_id });
    if (r.grant_id !== args.grant_id) throw new Error('Run does not belong to this grant');
    return r;
  }
  await host.developmentAuthorize(owner, args.grant_id, args.conversation_id ?? grant.manifest.conversation_id);
  if (operation === 'start_development_task') return dispatch('dev_start', { ...args, policy_digest: grant.manifest.policy_digest });
  if (operation === 'export_development') return dispatch('dev_export', { ...args, conversation_id: grant.manifest.conversation_id, policy_digest: grant.manifest.policy_digest });
  throw new Error('Unknown development operation');
}
