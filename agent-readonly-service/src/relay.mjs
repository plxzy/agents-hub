import { validateRelay } from '../../agent-workflow/relay-contract.mjs';
import { storeRun, readRun } from './runs.mjs';
const json = (x, status) => Response.json(x, { status, headers: { 'cache-control': 'no-store' } });
const relay = (env) => env.RELAY.getByName('owner-mac');
export async function relayStatus(env) {
  const unavailable = () => ({ online: false, enabled: false, agents: [], available: false });
  if (!env.RELAY_TOKEN || !env.RELAY) return unavailable();
  try { return await relay(env).status(); }
  catch { return unavailable(); }
}
export async function relayFetch(request, env) {
  const pathname = new URL(request.url).pathname;
  const dok = pathname.startsWith('/relay/dok-dev/');
  const token = dok ? env.DOK_RELAY_TOKEN : env.RELAY_TOKEN;
  if (!token || dok && env.DEVELOPMENT_ENABLED !== 'true') return json({ error: 'unauthorized' }, 401);
  const digest = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(request.headers.get('authorization') ?? ''), digest('Bearer ' + token)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return json({ error: 'unauthorized' }, 401);
  const target = dok ? env.RELAY.getByName('owner-dok-dev') : relay(env);
  if (dok && pathname === '/relay/dok-dev/lease' && request.method === 'POST') {
    try {
      const text = await request.text();
      if (text.length > 2048) throw new Error('Invalid lease');
      return json(await target.developmentLease(JSON.parse(text)));
    } catch { return json({ authorized: false, error: 'Lease refused' }, 403); }
  }
  if (dok && pathname === '/relay/dok-dev/runs' && request.method === 'POST') {
    try {
      const text = await request.text();
      if (text.length > 262144) throw new Error('Receipt too large');
      const r = await storeRun(env, JSON.parse(text), 'dok');
      return json({ ok: true, run_id: r.run_id, status: r.status });
    } catch { return json({ ok: false, error: 'Receipt refused' }, 400); }
  }
  if (pathname !== (dok ? '/relay/dok-dev/connect' : '/relay/connect')) return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  return target.fetch(request);
}
export async function requestRelay(env, operation, args) {
  validateRelay(operation, args);
  if (!env.RELAY_TOKEN || !env.RELAY) throw new Error('Mac is offline. No action was queued.');
  let result;
  try { result = await relay(env).dispatch(operation, args); }
  catch (e) {
    // RPC/runtime loss is potentially after dispatch. Never silently retry a mutation here.
    if (/reset|disconnect|network|internal|broken|overload/i.test(e.message)) throw new Error(`Relay transport interrupted; action may have completed. Retry with the SAME request_id: ${args.request_id ?? '(read-only call)'}`);
    throw e;
  }
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export const dokEnabled = (env) => Boolean(env.DOK_RELAY_TOKEN && env.RELAY && env.DEVELOPMENT_ENABLED === 'true');
export async function dokStatus(env) {
  if (!dokEnabled(env)) return { online: false, enabled: false, agents: [], available: false };
  try { return await env.RELAY.getByName('owner-dok-dev').status(); }
  catch { return { online: false, enabled: false, agents: [], available: false }; }
}
const NEXT = 'Poll get_run with this run_id until status is no longer running (usually one to a few minutes). Do not start a duplicate run.';

/** dok first (always-on runner); the optional Mac relay only for agents dok does not offer. */
export async function startRun(env, args) {
  validateRelay('start_run', args);
  const dok = await dokStatus(env);
  if (dok.online && dok.agents.includes(args.agent) && args.agent !== 'workflow') {
    if (args.continue) throw new Error('continue is not supported on dok yet; start a new run and include the needed context in the task. No action was queued.');
    const result = await env.RELAY.getByName('owner-dok-dev').dispatch('run_start', { request_id: args.request_id, agent: args.agent, task: args.task });
    if (!result.ok) throw new Error(result.error);
    try { await storeRun(env, result.value, 'dok'); } catch { /* dok also posts its receipt */ }
    return { run_id: result.value.run_id, agent: args.agent, status: result.value.status, runner: 'dok', next_step: NEXT };
  }
  const mac = await relayStatus(env);
  if (mac.online) return { ...(await requestRelay(env, 'start_run', args)), runner: 'mac', next_step: NEXT };
  const offered = dok.online ? dok.agents.filter((a) => a !== 'workflow') : [];
  throw new Error(dok.online ? `dok does not run ${args.agent}; it offers: ${offered.join(', ') || 'none'}. The Mac relay is offline. No action was queued.`
    : 'No runner is online (dok and the Mac relay are both offline). No action was queued.');
}

/** Hub receipts first; Mac relay runs are read live from the Mac when it is online. */
export async function getRun(env, runId) {
  const hub = await readRun(env, runId);
  if (hub) return hub;
  if ((await relayStatus(env)).online) return requestRelay(env, 'get_remote_run', { run_id: runId });
  return null;
}
