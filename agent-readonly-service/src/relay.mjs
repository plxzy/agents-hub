import { publisherFetch, ensurePublication, publishReview } from './review-publications.mjs';
import { validateRelay } from '../../agent-workflow/relay-contract.mjs';
import { validateSelectedStart, REQUEST_ID, dokTarget } from '../../agent-workflow/run-selection.mjs';
import { storeRun, readRun, runForRequest } from './runs.mjs';
import { bundleFor, pendingMemory } from './memory.mjs';
import { decisionsSince } from './decisions.mjs';
import { publishKnowledge, knowledgeRevision, agentBundle, readFiles } from './knowledge.mjs';
import { readAccounts, recordAccount } from './accounts.mjs';
import { mcpConnection } from '../../agent-workflow/run-config.mjs';
import { uploadArtifact, downloadArtifact } from './run-artifacts.mjs';
import { ARTIFACT_RUN_ID } from '../../agent-workflow/run-artifact-contract.mjs';
const json = (x, status) => Response.json(x, { status, headers: { 'cache-control': 'no-store' } });
export async function relayFetch(request, env, readPanel) {
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith('/relay/publisher/')) return publisherFetch(request, env);
  const dok = pathname.startsWith('/relay/dok-dev/'), mac = pathname.startsWith('/relay/mac/');
  if (!dok && !mac) return json({ error: 'not_found' }, 404); // the Mac no longer connects (retired 2026-10-12)
  const token = dok ? env.DOK_RELAY_TOKEN : env.MAC_TOKEN;
  if (!token || dok && env.DEVELOPMENT_ENABLED !== 'true') return json({ error: 'unauthorized' }, 401);
  const digest = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(request.headers.get('authorization') ?? ''), digest('Bearer ' + token)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return json({ error: 'unauthorized' }, 401);
  const artifactPrefix = dok ? '/relay/dok-dev/artifacts/' : '/relay/mac/artifacts/';
  if (pathname.startsWith(artifactPrefix)) {
    const id = pathname.slice(artifactPrefix.length);
    if (!ARTIFACT_RUN_ID.test(id)) return json({ error: 'Invalid run' }, 400);
    if (request.method !== (dok ? 'PUT' : 'GET')) return json({ error: 'method_not_allowed' }, 405);
    try {
      const receipt = await readRun(env, id);
      if (!receipt) return json({ error: 'Unknown run' }, 404);
      const response = dok ? await uploadArtifact(request, env, receipt) : await downloadArtifact(env, receipt);
      if (dok && response.ok) await ensurePublication(env, receipt);
      return response;
    } catch { return json({ error: 'Artifact unavailable' }, 503); }
  }
  const target = dok ? env.RELAY.getByName('owner-dok-dev') : null;
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
  // The Mac's own principal: posts its receipts, reads bundles and decisions. It can request selected dok starts; it cannot rate, decide or read /mcp.
  if (mac) return macRoute(request, env, pathname, readPanel);
  if (pathname !== '/relay/dok-dev/connect') return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  return target.fetch(request);
}
export const dokEnabled = (env) => Boolean(env.DOK_RELAY_TOKEN && env.RELAY && env.DEVELOPMENT_ENABLED === 'true');
export async function dokStatus(env) {
  if (!dokEnabled(env)) return { online: false, enabled: false, agents: [], available: false };
  try { return await env.RELAY.getByName('owner-dok-dev').status(); }
  catch { return { online: false, enabled: false, agents: [], available: false }; }
}
const NEXT = 'Poll get_run with this run_id until status is no longer running (usually one to a few minutes). Do not start a duplicate run.';

/** Starts a run on dok, the always-on runner. */
export async function startRun(env, args, { mac = false } = {}) {
  if (!mac && args?.request_id?.startsWith('mac-')) throw new Error('Reserved request namespace');
  const connection = mac ? mcpConnection(args?.mcp_connection) : undefined;
  const publicArgs = { ...args }; delete publicArgs.mcp_connection;
  validateRelay('start_run', publicArgs);
  const dok = await dokStatus(env);
  if (dok.online && dok.agents.includes(args.agent)) {
    if (args.continue) throw new Error('continue is not supported on dok yet; start a new run and include the needed context in the task. No action was queued.');
    const result = await env.RELAY.getByName('owner-dok-dev').dispatch('run_start', { request_id: args.request_id, agent: args.agent, task: args.task,
      ...(args.model ? { model: args.model } : {}), ...(args.thinking ? { thinking: args.thinking } : {}),
      ...(args.pr_number ? { pr_number: args.pr_number } : {}),
      ...(args.repo ? { repo: args.repo } : {}), ...(args.continue_from ? { continue_from: args.continue_from } : {}),
      ...(connection ? { mcp_connection: connection } : {}) });
    if (!result.ok) throw new Error(result.error);
    try { await storeRun(env, result.value, 'dok'); } catch { /* dok also posts its receipt */ }
    return { run_id: result.value.run_id, agent: args.agent, status: result.value.status, runner: 'dok', ...(result.value.repo ? { repo: result.value.repo } : {}), model: result.value.model, thinking: result.value.thinking, next_step: NEXT };
  }
  if (args.agent === 'workflow' && !dok.online) throw new Error('workflow runs on dok, which is offline. For interactive development call request_development to show the approval card when dok is online. No task was started.');
  const offered = dok.online ? dok.agents : [];
  throw new Error(dok.online ? `dok does not run ${args.agent}; it offers: ${offered.join(', ') || 'none'}. No action was queued.`
    : 'No runner is online (dok is offline). No action was queued.');
}

/** Receipts held by the Hub. */
export async function getRun(env, runId) {
  const hub = await readRun(env, runId);
  if (hub) return hub;
  return null;
}

async function macRoute(request, env, pathname, readPanel) {
  const get = request.method === 'GET', url = new URL(request.url);
  const scopes = (url.searchParams.get('scopes') ?? '').split(',').filter(Boolean).slice(0, 10);
  try {
    if (pathname === '/relay/mac/start' && request.method === 'POST') {
      const body = await request.text();
      if (body.length > 65536) return json({ error: 'Start request too large' }, 400);
      let args;
      try { args = JSON.parse(body); const connection = mcpConnection(args.mcp_connection); delete args.mcp_connection; validateSelectedStart(args, true); if (connection) args.mcp_connection = connection; }
      catch (e) { return json({ error: e.message }, 400); }
      const target = dokTarget(await dokStatus(env));
      const agent = target.agents.find(a => a.name === args.agent);
      if (!target.available || !agent || agent.reason) return json({ error: target.reason ?? agent?.reason ?? 'Agent is not runnable on dok' }, 409);
      try { return json(await startRun(env, { ...args, request_id: 'mac-' + args.request_id }, { mac: true })); }
      catch { return json({ error: 'Start response unavailable or refused. Check the original request before submitting another task.', request_id: args.request_id }, 503); }
    }
    if (pathname.startsWith('/relay/mac/starts/') && get) {
      const externalId = pathname.slice('/relay/mac/starts/'.length);
      if (!REQUEST_ID.test(externalId)) return json({ error: 'Invalid request identity' }, 400);
      const id = 'mac-' + externalId;
      const saved = await runForRequest(env, id);
      if (saved) return json(saved);
      const host = env.RELAY.getByName('owner-dok-dev'), known = await host.requestStatus(id);
      if (known.state !== 'unknown') return json(known);
      const dok = await dokStatus(env);
      if (!dok.online || dok.run_selection?.version !== 1) return json({ state: 'unknown', reason: 'dok cannot reconcile this request right now.' });
      const found = await host.dispatch('run_lookup', { target_request_id: id });
      // Lookup runs through the same ordered command queue as start; it never executes work.
      return json(found.ok ? found.value : { state: 'unknown', reason: 'Request lookup unavailable.' });
    }
    if (pathname === '/relay/mac/publish-review' && request.method === 'POST') return json(await publishReview(env, await request.json()));
    if (pathname === '/relay/mac/panel' && get) return readPanel
      ? json(await readPanel()) : json({ error: 'Panel unavailable' }, 503);
    if (pathname.startsWith('/relay/mac/runs/') && get) {
      const run = await readRun(env, pathname.slice('/relay/mac/runs/'.length));
      return run ? json(run) : json({ error: 'Unknown run' }, 404);
    }
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

/** Read-only reconciliation for hosted callers; absence is never permission to duplicate. */
export async function getStartStatus(env, requestId) {
  validateRelay('get_start_status', { request_id: requestId });
  const saved = await runForRequest(env, requestId);
  if (saved) return saved;
  const host = env.RELAY.getByName('owner-dok-dev');
  const known = await host.requestStatus(requestId);
  if (known.state !== 'unknown') return known;
  if (!(await dokStatus(env)).online) return { state: 'unknown', reason: 'Runner unavailable for reconciliation' };
  const result = await host.dispatch('run_lookup', { target_request_id: requestId });
  return result.ok && result.value.state === 'started' ? result.value
    : { state: 'unknown', reason: 'No accepted run established; keep the original request identity' };
}
export async function resumeRun(env, args, { approved = false } = {}) {
  validateRelay('resume_run', args);
  const result = await env.RELAY.getByName('owner-dok-dev').dispatch('run_resume', { ...args, approved });
  if (!result.ok) throw Error(result.error);
  try { await storeRun(env, result.value, 'dok'); } catch { /* Runner retries publication. */ }
  const r = result.value;
  return { run_id: r.run_id, agent: r.agent, runner: 'dok', status: r.status, recovery: r.recovery };
}
