import { publishReview, publicationHealth, withRunnerPublishing } from './review-publications.mjs';
import { dokTarget } from '../../agent-workflow/run-selection.mjs';
import { DASHBOARD_URI, isDashboardUri, DASHBOARD_TOOL_META, DASHBOARD_RESOURCE_META, DASHBOARD_ICONS, READ_OPS, lastRunOf } from '../../agent-workflow/contract.mjs';
import { accessSubject } from './access.mjs';
import { RELAY_OPS, RUN_CONTROLS, relayToolList, validateRelay } from '../../agent-workflow/relay-contract.mjs';
import { relayFetch, startRun, getRun, getStartStatus, resumeRun, controlRun, runActions, dokEnabled, dokStatus } from './relay.mjs';
import { readRun, recentRuns, archiveSuggestions, setArchived } from './runs.mjs';
import { readAccounts } from './accounts.mjs';
import { issueCodes, redeemCode, rateRun } from './decisions.mjs';
import { agentSummaries } from './knowledge.mjs';
import { pendingMemory, pendingCounts, isMemory, decideMemory } from './memory.mjs';
import { healthOf, healthTime } from '../../agent-workflow/health.mjs';
import { DEV_OPS, developmentTools } from '../../agent-workflow/dev-contract.mjs';
import { developmentCall } from './development.mjs';
import { vmControlEnabled, submitVmControl, getVmControl } from './vm-control.mjs';

const CAPABILITIES = { discovery: true, status: true, context: true, run: false, mutate: false };
const MCP_MIME = 'text/html;profile=mcp-app';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const unauthorized = () => json({ error: 'unauthorized' }, 401);

// The read tools the shared contract (agent-workflow/contract.mjs) defines; every answer comes from D1 and the runner's
// live status, so the one dashboard reads local and hosted data alike.
const TOOLS = ['open_dashboard', 'get_status', 'list_agents', 'list_runs', 'get_run'].map((name) => ({ name, ...READ_OPS[name] }));

function hubCounts(runs) {
  const last = runs.filter((r) => r.status !== 'running').at(-1);
  return { runs: runs.length, running: runs.filter((r) => r.status === 'running').length,
    last_run: last ? { run_id: last.run_id, agent: last.agent, status: last.status, ended: last.ended } : null };
}
const withLast = (list, runs) => list.map((a) => ({ ...a, last_run: lastRunOf(a.name, runs) }));
const relaySource = (dok) => dok.available === false ? 'Durable Object status unavailable' : 'Durable Object status';

// Panel data: runs from D1, the dok runner's agents and one-time codes for the user's decisions on Hub runs. The
// dashboard treats `relay` as "a hosted runner is online", so dok presents itself there.
async function nativePanel(env, { withConfirm = false } = {}) {
  // Independent reads run together: each D1 round trip can cost tens of milliseconds.
  const [hubRuns, dok, published, notes, publicationHealthNow] = await Promise.all([recentRuns(env, { limit: 50 }), dokStatus(env),
    agentSummaries(env), pendingMemory(env), publicationHealth(env)]);
  const known = new Set(published.map((a) => a.name));
  const agents = [...withLast(published, hubRuns).map((a) => ({ ...a, remote_allowed: dok.agents.includes(a.name) })),
    ...dok.agents.filter((n) => !known.has(n)).map((name) => ({ name, description: 'Runs on dok.', remote_allowed: true, last_run: null }))];
  const runs = hubRuns;
  // Only the authenticated Hub widget requests codes. Mac reads do not even issue them.
  const finished = hubRuns.filter((r) => ['completed', 'failed', 'interrupted'].includes(r.status)).map((r) => r.run_id);
  const [rate, review, recovery, archive] = withConfirm ? await Promise.all([
    issueCodes(env, 'rate', finished),
    issueCodes(env, 'review', notes.map((n) => n.id)),
    issueCodes(env, 'recovery', hubRuns.filter(r => r.recovery?.state === 'awaiting_review' && r.recovery?.checkpoint_version).map(r => `${r.run_id}:${r.recovery.checkpoint_version}`)),
    issueCodes(env, 'archive', finished),
  ]) : [];
  const confirm = withConfirm ? { rate, review, recovery, archive } : null;
  const pending = notes;
  const relay = { ...dok, runner: 'dok' };
  // The same health report open_dashboard gives, so the panel can poll this one call alone.
  const health = runnerHealth(healthOf({ agents, runs, relay, relay_source: relaySource(dok) }, { expected: dok.agents }), dok);
  return { source: 'hub', generated_at: new Date().toISOString(), agents, runs, pending, health, hub_panel: true,
    development_available: Boolean(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true'),
    publication_health: publicationHealthNow,
    // Archiving is the user's click; these are only offered, with the reason for each run.
    ...(withConfirm ? { archive_suggestions: archiveSuggestions(hubRuns) } : {}),
    run_targets: [dokTarget(dok, agents)],
    status: { agents: agents.length, ...hubCounts(hubRuns), pending: { memory: notes.length, proposals: 0 } },
    capabilities: { ...CAPABILITIES, run: withConfirm && dok.online && dok.agents.length > 0, mutate: withConfirm },
    ...(confirm ? { confirm } : {}), relay };
}

function runnerHealth(health, dok) {
  if (dok.online && dok.agents.length) health.execution = { ...health.execution, available: true, runner: 'dok', reason: `dok runner online; start_run runs: ${dok.agents.join(', ')}` };
  return health;
}

/**
 * A short fingerprint of everything the panel shows, from a handful of indexed or tiny reads, so the panel can poll
 * often and fetch the full data only when it changed. Timestamps that move on every heartbeat are left out; the panel
 * still does a full read at least once a minute (labels, codes). null when it cannot be computed.
 */
async function panelVersion(env, owner) {
  try {
    const q = (sql) => env.DB.prepare(sql);
    const [rows, dok, development] = await Promise.all([
      env.DB.batch([
        q('SELECT MAX(updated_at) AS v FROM runs'),
        q("SELECT COUNT(*) AS n, MAX(created) AS c, MAX(decided) AS d FROM memory WHERE status = 'candidate' OR decided IS NOT NULL"),
        q('SELECT COUNT(*) AS n, MAX(rated_at) AS v FROM ratings'),
        q(`SELECT group_concat(run_id || ':' || status || ':' || attempts || ':' || COALESCE(pr_url, '') || ':' || COALESCE(error, ''), '|') AS v
          FROM review_publications WHERE run_id IN (SELECT run_id FROM runs WHERE archived_at IS NULL ORDER BY started DESC LIMIT 50)`),
        q("SELECT group_concat(root || ':' || COALESCE(observation, ''), '|') AS v FROM review_threads"),
        q("SELECT group_concat(slot || ':' || state || ':' || updated_at, '|') AS v FROM accounts"),
        q("SELECT value AS v FROM knowledge_state WHERE key = 'revision'"),
        q('SELECT observed_at AS v FROM review_publisher_health WHERE id = 1'),
      ]),
      dokStatus(env),
      owner && env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true' ? developmentCall(env, owner, 'get_development', {}).then((d) => d.grants).catch(() => null) : null,
    ]);
    const [runs, memory, ratings, publications, threads, accounts, revision, publisher] = rows.map((r) => r.results);
    const publisherOnline = !!publisher[0]?.v && Date.now() - Date.parse(publisher[0].v) < 60000;
    const text = JSON.stringify([runs, memory, ratings, publications, threads, accounts, revision, publisherOnline,
      [dok.online, dok.enabled, dok.available, dok.agents, dok.pending_starts, dok.run_selection], development]);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

const toolList = TOOLS.map(({ name, title, description, input, annotations, ui }) => ({
  name, title, description, inputSchema: input, annotations: { title, ...annotations, readOnlyHint: true },
  ...(ui ? { icons: DASHBOARD_ICONS, _meta: DASHBOARD_TOOL_META } : {}),
}));

export async function apiFetch(request, env, dashboardHtml = '', owner = null) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/mcp') return json({ error: 'not_found' }, 404);
  {
    let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
    const { id, method, params } = msg ?? {};
    // Connection, discovery and UI resources answer without any data.
    if (id === undefined || id === null) return new Response(null, { status: 202 });
    const reply = (result) => json({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'agents-hub', title: 'Agents Hub', version: '0.4.0' },
      instructions: dokEnabled(env)
        ? 'Agents Hub runs the user\u2019s own Pi agents. They run on dok, the user\u2019s always-on Linux runner, so the Mac does not need to be online. For questions about the user\u2019s repositories (where something is, how it works) call start_run with a read-only agent such as helper. For coding work call start_run with an agent that changes files (the agents get_status lists under start_run.runners.dok, e.g. workflow for dev-workflow, vm, tikkytracker): it works in an isolated clone on dok and returns a saved review. GitHub-enabled repositories automatically publish draft PRs; poll get_run.publication for the PR URL or blocker. A completed coding run alone does not establish publication. Nothing is merged. Read get_run first and follow next_action. Completed reviews need continue_from; eligible failed work needs resume_run. pause_run, cancel_run, dismiss_run and retry_inspection act on one dok run and return a recorded receipt (list_run_actions); pass issue_number to start_run to link a GitHub issue. A run ID only in task prose does not attach its files. Never substitute a fresh main clone for retained work. Poll get_run for results. Prefer start_run over delegating to Codex cloud tasks or driving the user\u2019s Mac. request_development (approval card, then start_development_task) is the older interactive route for workflow. Ratings and reviews are user clicks in the panel, never model decisions.'
        : 'Read-only Agents Hub view of the user’s local agents and runs. Check get_status for freshness; run is explicitly unavailable.' });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [...(dokEnabled(env) ? [
      ...toolList.map((t) => t.name === 'open_dashboard' ? { ...t, description: READ_OPS.open_dashboard.description + ' The panel shows runs, agents and the review queue held by the Hub.' } : t),
      ...relayToolList().filter((t) => ['publish_review', 'start_run', 'get_start_status', 'resume_run', ...Object.keys(RUN_CONTROLS), 'list_run_actions', 'decide_recovery', 'get_remote_run', 'panel_data', 'panel_run', 'rate_run', 'review_decide', 'panel_archived', 'archive_runs'].includes(t.name)),
    ] : toolList), ...(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true' ? developmentTools() : []),
    ...(vmControlEnabled(env) ? relayToolList().filter((t) => ['submit_vm_control', 'get_vm_control'].includes(t.name)) : [])] });
    if (method === 'resources/list') return reply({ resources: [{ uri: DASHBOARD_URI, name: 'Agents Hub dashboard', mimeType: MCP_MIME }] });
    if (method === 'resources/read') {
      if (!isDashboardUri(params?.uri)) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown resource' } });
      return reply({ contents: [{ uri: DASHBOARD_URI, mimeType: MCP_MIME, text: dashboardHtml, _meta: DASHBOARD_RESOURCE_META }].map((c) => ({ ...c, uri: params.uri })) });
    }
    if (method === 'tools/call') {
      if (params?.name === 'publish_review' && dokEnabled(env)) {
        try { return reply({ content: [{ type: 'text', text: JSON.stringify(await publishReview(env, params.arguments)) }] }); }
        catch (e) { return reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
      }
      if (Object.hasOwn(DEV_OPS, params?.name ?? '')) {
        try {
          const { confirm, ...value } = await developmentCall(env, owner, params.name, params.arguments ?? {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(value) }],
            ...(params.name === 'request_development' ? { structuredContent: { ...value, view: 'development',
              next_step: 'The user must approve this session in the card. Then check get_development and submit the task with start_development_task.' } } : {}),
            ...(confirm ? { _meta: { 'agents-hub/development-confirm': confirm } } : {}) });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      // The panel, ratings and review decisions are served by the Hub from D1.
      if (dokEnabled(env) && ['panel_data', 'panel_run', 'rate_run', 'review_decide', 'decide_recovery', 'panel_archived', 'archive_runs'].includes(params?.name)) {
        try {
          const args = params.arguments ?? {};
          if (params.name === 'panel_data') {
            const version = await panelVersion(env, owner);
            if (version && args.since === version) return reply({ content: [{ type: 'text', text: JSON.stringify({ unchanged: true, version }) }] });
            const { confirm, ...value } = await nativePanel(env, { withConfirm: true });
            // The Development tab comes with the panel, so one host call refreshes everything.
            let devConfirm;
            if (value.development_available) {
              try { const { confirm: c, ...d } = await developmentCall(env, owner, 'development_panel', {}); value.development = d; devConfirm = c; }
              catch { /* the panel falls back to its own development_panel call */ }
            }
            return reply({ content: [{ type: 'text', text: JSON.stringify({ ...value, ...(version ? { version } : {}) }) }],
              _meta: { 'agents-hub/confirm': confirm, ...(devConfirm ? { 'agents-hub/development-confirm': devConfirm } : {}) } });
          }
          if (params.name === 'panel_archived') {
            const runs = await recentRuns(env, { archived: true, limit: 100 });
            const codes = await issueCodes(env, 'archive', runs.map((r) => r.run_id));
            return reply({ content: [{ type: 'text', text: JSON.stringify({ runs }) }], _meta: { 'agents-hub/archived-confirm': codes } });
          }
          if (params.name === 'archive_runs') {
            validateRelay('archive_runs', args);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await setArchived(env, args)) }] });
          }
          if (params.name === 'panel_run') {
            const run = await readRun(env, args.run_id);
            if (run) return reply({ content: [{ type: 'text', text: JSON.stringify(run) }] });
          }
          if (params.name === 'decide_recovery') {
            validateRelay('decide_recovery', args);
            await redeemCode(env, args.confirm, 'recovery', `${args.run_id}:${args.checkpoint_version}`);
            const { confirm: _confirm, ...resume } = args;
            return reply({ content: [{ type: 'text', text: JSON.stringify(await resumeRun(env, resume, { approved: true })) }] });
          }
          if (params.name === 'review_decide' && await isMemory(env, args.id)) {
            validateRelay('review_decide', args);
            await redeemCode(env, args.confirm, 'review', args.id);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await decideMemory(env, args)) }] });
          }
          if (params.name === 'rate_run' && await readRun(env, args.run_id)) {
            validateRelay('rate_run', args);
            await redeemCode(env, args.confirm, 'rate', args.run_id);
            return reply({ content: [{ type: 'text', text: JSON.stringify(await rateRun(env, args)) }] });
          }
          if (params.name === 'panel_run') throw new Error('Unknown run ' + args.run_id);
          if (params.name === 'rate_run') throw new Error('Unknown run ' + args.run_id);
          if (params.name === 'review_decide') throw new Error('Unknown review item ' + args.id);
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      // VM worker control: the runner's grants decide; the Hub only forwards. Listed and callable only with VM_CONTROL_ENABLED.
      if (['submit_vm_control', 'get_vm_control'].includes(params?.name)) {
        try {
          const value = params.name === 'submit_vm_control' ? await submitVmControl(env, owner, params.arguments ?? {}) : await getVmControl(env, owner, params.arguments ?? {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      if (dokEnabled(env) && ['start_run', 'get_remote_run', 'get_start_status', 'resume_run', ...Object.keys(RUN_CONTROLS), 'list_run_actions'].includes(params?.name)) {
        try {
          const args = params.arguments ?? {};
          const result = params.name === 'start_run' ? await startRun(env, args)
            : Object.hasOwn(RUN_CONTROLS, params.name) ? await controlRun(env, params.name, args)
            : params.name === 'list_run_actions' ? await runActions(env, args)
            : params.name === 'get_start_status' ? await getStartStatus(env, args.request_id)
            : params.name === 'resume_run' ? await resumeRun(env, args) : await getRun(env, args.run_id);
          if (params.name === 'get_remote_run' && !result) throw new Error('Unknown run ' + args.run_id + ' (not in the Hub).');
          const { confirm, ...value } = result ?? {};
          // Confirmation codes go only to the panel: hosts pass a result's _meta to the widget, never to the model.
          return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(confirm ? { _meta: { 'agents-hub/confirm': confirm } } : {}) });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
      }
      const tool = TOOLS.find((x) => x.name === params?.name);
      if (!tool) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params?.name } });
      try {
        const args = params.arguments ?? {};
        const answer = (value) => reply({ content: [{ type: 'text', text: tool.ui ? tool.summary(value) : JSON.stringify(value, null, 2) }], ...(tool.ui ? { structuredContent: value } : {}) });
        if (params.name === 'get_run') {
          const run = await readRun(env, args.run_id);
          if (!run) throw new Error('no run ' + args.run_id);
          return answer(run);
        }
        if (params.name === 'list_runs') return answer({ runs: await recentRuns(env, { agent: args.agent, limit: args.limit ?? 10 }) });
        const [hubRuns, published] = await Promise.all([recentRuns(env, { limit: 200 }), agentSummaries(env)]);
        const agentList = withLast(published, hubRuns);
        if (params.name === 'list_agents') return answer({ agents: agentList });
        const [dok, accounts, publication_health, notes] = await Promise.all([dokStatus(env), readAccounts(env), publicationHealth(env), pendingCounts(env)]);
        // An empty answer may be a failed read, so no runs and no agents stay unknown rather than zero.
        const status = hubRuns.length || agentList.length ? { agents: agentList.length, ...hubCounts(hubRuns), pending: notes === null ? null : { memory: notes, proposals: 0 } }
          : { agents: null, runs: null, running: null, last_run: null, pending: null };
        const value = params.name === 'get_status' ? { ...status, capabilities: CAPABILITIES }
          : { generated_at: new Date().toISOString(), capabilities: CAPABILITIES, status, agents: agentList, runs: hubRuns.slice(-50), pending: null };
        {
          value.development_available = Boolean(env.DOK_RELAY_TOKEN && env.DEVELOPMENT_ENABLED === 'true');
          value.hub_panel = dokEnabled(env);
          value.runners = { dok };
          value.accounts = accounts;
          value.publication_health = withRunnerPublishing(publication_health, dok.run_selection);
          // The runner (dok) is what the panel and the health report call "relay": the Mac no longer connects.
          value.relay = { ...dok, runner: 'dok' };
          value.health = healthOf({ ...value, relay_source: relaySource(dok) }, { expected: dok.agents });
          // Callers decide from this summary whether start_run works.
          const dokAgents = dok.online ? dok.agents : [];
          value.start_run = dokAgents.length
            ? { available: true, runners: { dok: dokAgents }, note: 'start_run works now: it runs on dok, the always-on Linux runner. Poll get_run for the result.' }
            : { available: false, note: 'dok is offline, so no runner is available.' };
          if (dokAgents.length) {
            runnerHealth(value.health, dok);
            if (params.name === 'get_status') value.capabilities = { ...value.capabilities, run: true };
          }
        }
        const shown = params.name === 'get_status' && value.start_run ? { start_run: value.start_run, ...value } : value;
        return reply({ content: [{ type: 'text', text: tool.ui ? tool.summary(value) : JSON.stringify(shown, null, 2) }], ...(tool.ui ? { structuredContent: value } : {}) });
      } catch (e) { return reply({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); }
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
  return json({ error: 'not_found' }, 404);
}

export async function defaultFetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'agents-hub', capabilities: CAPABILITIES });
  // Access points clients at its own metadata in the 401; this answers clients that look in the standard place.
  if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
    return json({ resource: url.origin + '/mcp', authorization_servers: [env.ACCESS_ISSUER], bearer_methods_supported: ['header'], resource_name: 'Agents Hub' });
  }
  return json({ error: 'not_found' }, 404);
}


/**
 * The whole Worker. Cloudflare Access (an Access application on /mcp with Managed OAuth) is the OAuth server: it
 * signs the user in, registers clients and issues tokens, then forwards each request with a signed
 * Cf-Access-Jwt-Assertion. The Worker checks that assertion itself too, so a request that reached it some other way
 * (a preview URL, a missing Access application) is refused. /health stays outside.
 */
export async function hubFetch(request, env, dashboardHtml = '', keys) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/relay/')) return relayFetch(request, env, () => nativePanel(env));
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    const owner = await accessSubject(request, env, keys);
    if (!owner) return unauthorized();
    return apiFetch(request, env, dashboardHtml, owner);
  }
  return defaultFetch(request, env);
}
