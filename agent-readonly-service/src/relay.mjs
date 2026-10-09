import { validateRelay } from '../../agent-workflow/relay-contract.mjs';
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
