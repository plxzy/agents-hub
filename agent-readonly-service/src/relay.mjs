import { validateRelay } from '../../agent-workflow/relay-contract.mjs';
import { storeRun, readRun } from './runs.mjs';
import { bundleFor, pendingMemory } from './memory.mjs';
import { decisionsSince } from './decisions.mjs';
import { publishKnowledge, knowledgeRevision, agentBundle, readFiles } from './knowledge.mjs';
import { readAccounts, recordAccount } from './accounts.mjs';
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
  const dok = pathname.startsWith('/relay/dok-dev/'), mac = pathname.startsWith('/relay/mac/');
  const token = dok ? env.DOK_RELAY_TOKEN : mac ? env.MAC_TOKEN : env.RELAY_TOKEN;
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
  if (dok && pathname === '/relay/dok-dev/bundle' && request.method === 'GET') {
    try { return json(await bundleFor(env, (new URL(request.url).searchParams.get('scopes') ?? '').split(',').filter(Boolean).slice(0, 10))); }
    catch { return json({ error: 'Bundle unavailable' }, 503); }
  }
  if (dok && pathname === '/relay/dok-dev/knowledge' && request.method === 'GET') {
    try {
      const name = new URL(request.url).searchParams.get('agent');
      return json(name ? await agentBundle(env, name) : { revision: await knowledgeRevision(env), files: await readFiles(env, 'agents/%') });
    } catch (e) { return json({ error: /Unknown agent|Invalid agent/.test(e.message) ? e.message : 'Knowledge unavailable' }, /Unknown|Invalid/.test(e.message) ? 404 : 503); }
  }
  if (dok && pathname === '/relay/dok-dev/accounts') {
    if (request.method === 'GET') return json({ accounts: await readAccounts(env) });
    if (request.method === 'POST') {
      try {
        const text = await request.text();
        if (text.length > 2048) throw new Error('Too large');
        await recordAccount(env, JSON.parse(text), 'dok');
        return json({ ok: true });
      } catch { return json({ ok: false, error: 'Account state refused' }, 400); }
    }
  }
  // The Mac's own principal: posts its receipts, reads bundles and decisions. It cannot rate, decide, start or read /mcp.
  if (mac) return macRoute(request, env, pathname);
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
  if (dok.online && dok.agents.includes(args.agent)) {
    if (args.continue) throw new Error('continue is not supported on dok yet; start a new run and include the needed context in the task. No action was queued.');
    const result = await env.RELAY.getByName('owner-dok-dev').dispatch('run_start', { request_id: args.request_id, agent: args.agent, task: args.task,
      ...(args.model ? { model: args.model } : {}), ...(args.thinking ? { thinking: args.thinking } : {}),
      ...(args.repo ? { repo: args.repo } : {}), ...(args.continue_from ? { continue_from: args.continue_from } : {}) });
    if (!result.ok) throw new Error(result.error);
    try { await storeRun(env, result.value, 'dok'); } catch { /* dok also posts its receipt */ }
    return { run_id: result.value.run_id, agent: args.agent, status: result.value.status, runner: 'dok', ...(result.value.repo ? { repo: result.value.repo } : {}), model: result.value.model, thinking: result.value.thinking, next_step: NEXT };
  }
  const mac = await relayStatus(env);
  if (mac.online && (args.model || args.thinking || args.repo || args.continue_from)) throw new Error('Model, thinking, repo and continue_from are supported on dok only. No action was queued.');
  if (mac.online) return { ...(await requestRelay(env, 'start_run', args)), runner: 'mac', next_step: NEXT };
  if (args.agent === 'workflow' && !dok.online) throw new Error('workflow runs on dok, which is offline. For interactive development call request_development to show the approval card when dok is online. No task was started.');
  const offered = dok.online ? dok.agents : [];
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

async function macRoute(request, env, pathname) {
  const get = request.method === 'GET', url = new URL(request.url);
  const scopes = (url.searchParams.get('scopes') ?? '').split(',').filter(Boolean).slice(0, 10);
  try {
    if (pathname === '/relay/mac/runs' && request.method === 'POST') {
      const text = await request.text();
      if (text.length > 262144) throw new Error('Receipt too large');
      const r = await storeRun(env, JSON.parse(text), 'mac');
      return json({ ok: true, run_id: r.run_id, status: r.status });
    }
    if (pathname === '/relay/mac/knowledge') {
      if (get) return json({ revision: await knowledgeRevision(env) });
      if (request.method === 'POST') {
        const text = await request.text();
        if (text.length > 1_000_000) throw new Error('Too large');
        return json({ ok: true, ...(await publishKnowledge(env, JSON.parse(text))) });
      }
    }
    if (pathname === '/relay/mac/bundle' && get) return json(await bundleFor(env, scopes));
    if (pathname === '/relay/mac/pending' && get) return json({ pending: await pendingMemory(env) });
    if (pathname === '/relay/mac/decisions' && get) return json(await decisionsSince(env, url.searchParams.get('since')));
    if (pathname === '/relay/mac/accounts') {
      if (get) return json({ accounts: await readAccounts(env) });
      if (request.method === 'POST') {
        const text = await request.text();
        if (text.length > 2048) throw new Error('Too large');
        await recordAccount(env, JSON.parse(text), 'mac');
        return json({ ok: true });
      }
    }
  } catch (e) { return json({ ok: false, error: /^(The Hub holds|Push too large|Refused file|Invalid push)/.test(e.message) ? e.message : 'Request refused' }, 400); }
  return json({ error: 'not_found' }, 404);
}
