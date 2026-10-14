import { publicReview } from '../run-continuation.mjs';
import { publicationPending } from '../review-publication-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import http from 'node:http';
import { healthOf, healthLabels } from '../health.mjs';
import { runTrace, failureRows, progressRows, progressSummary, configurationRows } from '../run-trace.mjs';
import { bridgeScript, dashboardHtml } from './dashboard.mjs';
import { recoveryAction } from '../recovery-contract.mjs';
import { createUiServer } from './server.mjs';

test('recovery buttons use the same eligibility as the runner for failed and interrupted work', () => {
  const html = dashboardHtml();
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, S: { data: { relay: {} }, busy: new Set(), devRequests: new Map() }, recoveryAction,
    ago: () => 'now', h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(html.match(/function recoveryView\(r\) \{[\s\S]*?\n\}/)[0], context);
  const r = { run_id: 'r-20261014T000000Z-abcdef', status: 'failed', error: 'model turn failed',
    failure_context: { phase: 'model', message: 'OpenAI Responses stream ended before a terminal response event' },
    recovery: { state: 'ready', retained: true, checkpoint_version: 7, failed_resume_supported: true } };
  assert.match(JSON.stringify(context.recoveryView(r)), /Resume saved work/);
  delete r.recovery.failed_resume_supported;
  assert.doesNotMatch(JSON.stringify(context.recoveryView(r)), /Resume saved work/);
  r.recovery.failed_resume_supported = true;
  r.error = 'Execution lease refused';
  assert.doesNotMatch(JSON.stringify(context.recoveryView(r)), /Resume saved work/);
  r.status = 'interrupted';
  assert.match(JSON.stringify(context.recoveryView(r)), /Resume saved work/);
  r.recovery.state = 'awaiting_review'; r.recovery.inspection = 'Saved changes inspected';
  assert.match(JSON.stringify(context.recoveryView(r)), /Approve continuation from current files/);
  r.recovery.retained = false;
  assert.doesNotMatch(JSON.stringify(context.recoveryView(r)), /Approve continuation/);
});

test('the dashboard inlines the MCP Apps bridge and loads nothing from the network', () => {
  const html = dashboardHtml();
  assert.match(html, /globalThis\.ExtApps=\{[^}]*App:/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /__EXT_APPS_BUNDLE__/);
  assert.throws(() => bridgeScript('const a = 1;'), /unexpected ext-apps bundle format/);
});

test('agent ui needs its token and a loopback Host header', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-'));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents/demo.md'), `---\nname: demo\nworkspace: ${root}\n---\nTest.\n`);
  const { server, token } = createUiServer({ ctx: { root, state: path.join(root, 'state') }, token: 'tok' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (headers, body = { name: 'get_status' }) => fetch(`${base}/call`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  assert.equal((await fetch(`${base}/`)).status, 403);
  assert.equal((await fetch(`${base}/?t=wrong`)).status, 403);
  const page = await fetch(`${base}/?t=${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /x-agent-ui/);
  assert.equal((await post({})).status, 403);
  const ok = await (await post({ 'x-agent-ui': token })).json();
  assert.equal(JSON.parse(ok.content[0].text).agents, 1);
  const dash = await (await post({ 'x-agent-ui': token }, { name: 'open_dashboard' })).json();
  assert.equal(dash.structuredContent.agents[0].name, 'demo');
  assert.equal((await post({ 'x-agent-ui': token }, { name: 'nope' })).status, 404);
});

test('health chips put diagnostics in a native disclosure and keep its open state', () => {
  const html = dashboardHtml();
  const code = html.match(/function chips\(\) \{[\s\S]*?\n\}/)[0];
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, healthOf, healthLabels,
    S: { healthOpen: false, data: { source: 'hub', status: { agents: 6, running: 0, pending: { memory: 1, proposals: 0 } },
      relay: { online: true, enabled: true, agents: ['vm', 'workflow', 'helper', 'tikkytracker'], observed_at: new Date().toISOString(), last_seen_at: new Date().toISOString() } } },
    h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(code, context);
  const chips = context.chips(), disclosure = chips.find(x => x.tag === 'details');
  assert.ok(disclosure); assert.equal(disclosure.attrs.open, false);
  assert.equal(disclosure.children[0].tag, 'summary');
  assert.equal(disclosure.children[0].children[0], 'dok online · runs: helper, tikkytracker, vm, workflow');
  assert.equal(disclosure.children[1].tag, 'ul');
  assert.doesNotMatch(JSON.stringify(chips), /Snapshot|expected helper|Configuration allowlist/i);
  disclosure.attrs.ontoggle({ currentTarget: { open: true } });
  assert.equal(context.chips().find(x => x.tag === 'details').attrs.open, true);
  assert.match(html, /summary:focus-visible/);
  assert.match(html, /data.transport !== 'mac'/, 'Mac reads do not invoke hosted-only panel tools');
  assert.doesNotMatch(html, /last published snapshot|snapshot capabilities|expected helper|Configuration allowlist: unknown/i);
});

test('Hub running receipts poll quickly and detail reads work with dok offline', async () => {
  const html = dashboardHtml();
  const calls = [], delays = [];
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null,
    S: { data: { source: 'hub', snapshot: { stale: true }, relay: { online: false }, runs: [{ status: 'running' }] } },
    document: { hidden: false }, clearTimeout() {}, setTimeout: (_fn, delay) => { delays.push(delay); }, refresh() {},
    call: async (name, args) => { calls.push({ name, ...args }); return { run_id: args.run_id }; }, render() {}, showError: assert.fail,
  });
  vm.runInContext(html.match(/function scheduleRefresh\(\) \{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(html.match(/async function loadDetail\(id\) \{[\s\S]*?\n\}/)[0], context);
  context.scheduleRefresh();
  assert.equal(delays.pop(), 4000);
  await context.loadDetail('dok-run');
  assert.equal(calls.pop().name, 'panel_run');
  context.S.data.transport = 'mac';
  await context.loadDetail('dok-run');
  assert.equal(calls.pop().name, 'get_run');
  context.S.data.runs = [{ status: 'completed', publication: { status: 'queued' } }];
  context.scheduleRefresh();
  assert.equal(delays.pop(), 4000, 'publication keeps polling after coding completes');
  context.S.data.runs = [];
  context.scheduleRefresh();
  assert.equal(delays.pop(), 30000);
});

test('unknown Mac details refresh after contact returns and cannot be rated', () => {
  const html = dashboardHtml(), refreshed = [];
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null,
    S: { detail: { run_id: 'mac-run', agent: 'helper', status: 'unknown', error: 'Mac heartbeat expired' }, busy: new Set() },
    canDecide: () => true, list: () => null, runTrace, failureRows, progressRows, progressSummary, configurationRows, recoveryAction, loadDetail: id => refreshed.push(id), scheduleRefresh() {}, render() {},
    h: (tag, attrs, ...children) => ({ tag, attrs, children }),
  });
  vm.runInContext(html.match(/function recoveryView\(r\) \{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(html.match(/function detailView\(\) \{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(html.match(/function setData\(data\) \{[\s\S]*?\n\}/)[0], context);
  assert.doesNotMatch(JSON.stringify(context.detailView()), /rate-why/);
  context.setData({ runs: [] });
  assert.deepEqual(refreshed, ['mac-run']);
  context.S.detail.status = 'completed';
  assert.match(JSON.stringify(context.detailView()), /rate-why/);
});

test('run details render shared historical context as text and label absent fields', () => {
  const html = dashboardHtml({ bridge: '' });
  const receipt = { run_id: 'r-demo', agent: 'demo', repo: '<script>not executable</script>', commit: 'a'.repeat(40), status: 'failed', error: 'model turn failed' };
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, S: { detail: receipt, busy: new Set() }, runTrace, failureRows, progressRows, progressSummary, configurationRows, recoveryAction,
    canDecide: () => false, list: () => null, h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(html.match(/function recoveryView\(r\) \{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(html.match(/function detailView\(\) \{[\s\S]*?\n\}/)[0], context);
  const result = JSON.stringify(context.detailView());
  for (const [label, value] of runTrace(receipt)) { assert.ok(result.includes(label)); assert.ok(result.includes(value)); }
  assert.match(result, /Technical details and saved run evidence/);
  assert.doesNotMatch(result, /innerHTML/);
  assert.ok(html.includes('globalThis.AgentsHealth = { healthOf, healthLabels, dashboardHealth, runTrace, failureRows, progressRows, progressSummary, configurationRows };'));
  const bundled = vm.createContext({ publicationPending, publicationView: () => null,});
  const module = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].find((m) => m[1].includes('globalThis.AgentsHealth ='));
  vm.runInContext(module[1], bundled);
  assert.equal(JSON.stringify(bundled.AgentsHealth.runTrace(receipt)), JSON.stringify(runTrace(receipt)));
});

test('failed detail shows its error alongside labelled partial output and recorded diagnostics', () => {
  const html = dashboardHtml();
  const receipt = { run_id: 'r-failed', agent: 'helper', status: 'failed', error: 'model turn failed', output: 'Useful partial answer', output_partial: true,
    failure_context: { phase: 'model', last_tool: 'read', provider: 'openai', model: 'gpt-6-luna', message: '503 upstream disconnected' } };
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, S: { detail: receipt, busy: new Set() }, runTrace, failureRows, progressRows, progressSummary, configurationRows, recoveryAction,
    canDecide: () => false, list: () => null, h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(html.match(/function recoveryView\(r\) \{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(html.match(/function detailView\(\) \{[\s\S]*?\n\}/)[0], context);
  const result = JSON.stringify(context.detailView());
  for (const text of ['Error: model turn failed', 'Partial output', 'Useful partial answer', 'Last tool', 'read', '503 upstream disconnected', 'Failure category (inferred)', 'Agent / model', 'Next step']) assert.ok(result.includes(text), text);
  assert.equal(failureRows({ status: 'failed', error: 'old receipt' })[0][1], 'Unclassified');
  const bundled = vm.createContext({ publicationPending, publicationView: () => null,});
  vm.runInContext([...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].find(m => m[1].includes('globalThis.AgentsHealth ='))[1], bundled);
  assert.equal(JSON.stringify(bundled.AgentsHealth.failureRows(receipt)), JSON.stringify(failureRows(receipt)));
});

test('run list and detail expose live progress, stale checkpoints and missing older telemetry', () => {
  const html = dashboardHtml(), time = new Date(Date.now() - 60000).toISOString();
  const receipt = { run_id: 'live', agent: 'helper', status: 'running', progress: { phase: 'tool', action: 'tool_started',
    observed_at: time, last_tool: 'read', checkpoint: 'tool_error', checkpoint_tool: 'ls', checkpoint_at: time, blocker: 'tool_error' } };
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, S: { detail: receipt, data: { runs: [receipt] }, busy: new Set() }, runTrace, failureRows, progressRows, progressSummary, configurationRows, recoveryAction,
    canDecide: () => false, list: () => null, ago: () => '1m', firstLine: x => x, h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(html.match(/function recoveryView\(r\) \{[\s\S]*?\n\}/)[0], context);
  for (const name of ['detailView', 'runsView']) vm.runInContext(html.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0], context);
  const detail = JSON.stringify(context.detailView());
  for (const text of ['Run progress', 'Last reported phase', 'Latest checkpoint', 'ls reported an error', 'Last tool', 'read', 'Blocker', 'stale observation']) assert.ok(detail.includes(text), text);
  assert.match(JSON.stringify(context.runsView()), /read started.*stale observation/);
  delete receipt.progress;
  assert.match(JSON.stringify(context.detailView()), /not published telemetry/);
});

test('development task shows error and diagnostics alongside partial output', () => {
  const html = dashboardHtml();
  const receipt = { run_id: 'r-failed', status: 'failed', error: 'model turn failed', output: 'Partial development answer', output_partial: true,
    failure_context: { phase: 'model', last_tool: 'read', message: '503 upstream disconnected' } };
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, S: { development: { grants: [] }, devRun: receipt, busy: new Set() }, failureRows,
    h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(html.match(/function developmentView\(\) \{[\s\S]*?\n\}/)[0], context);
  const result = JSON.stringify(context.developmentView());
  for (const text of ['Error: model turn failed', 'Partial output', 'Partial development answer', 'Last tool', 'read', '503 upstream disconnected']) assert.ok(result.includes(text), text);
  context.S.devRun = { run_id: 'old-run', status: 'failed', error: 'old error', output: '' };
  const legacy = JSON.stringify(context.developmentView());
  assert.match(legacy, /Error: old error/);
  assert.doesNotMatch(legacy, /Partial output/);
});

test('runner form defaults to dok, preserves the task, and clears incompatible fields', async () => {
  const html = dashboardHtml(), calls = []; let pending;
  const S = { data: { transport: 'mac', runner_selection: 1, run_targets: [
    { id: 'dok', available: true, agents: [{ name: 'demo', description: 'Remote', repo: 'demo', model: 'openai/gpt-6-luna' }] },
    { id: 'mac', available: true, agents: [{ name: 'demo', description: 'Local', workspace: 'here' }] },
  ] }, form: { task: 'Keep this task', cwd: '/private/project', continue: true }, busy: new Set() };
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, S, crypto: { randomUUID: () => 'request-form-test' }, canRun: () => true, allowedForRun: () => true,
    h: (tag, attrs, ...children) => ({ tag, attrs, children: children.flat().filter(Boolean) }), firstLine: x => x,
    render() {}, showError: assert.fail, act: (_key, fn) => { pending = fn(); },
    call: async (name, args) => { calls.push({ name, args }); return { run_id: 'r-demo', status: 'running' }; },
    refresh: async () => {}, loadDetail: async () => {},
  });
  vm.runInContext(html.match(/function formView\(\) \{[\s\S]*?\n\}/)[0], context);
  const flatten = n => typeof n === 'object' ? [n, ...n.children.flatMap(flatten)] : [];
  let nodes = flatten(context.formView());
  assert.equal(S.form.runner, 'dok');
  assert.equal(nodes.some(n => n.attrs?.name === 'cwd'), false);
  assert.equal(nodes.some(n => n.attrs?.name === 'continue'), false);
  nodes.find(n => n.attrs?.name === 'runner').attrs.onchange({ target: { value: 'mac' } });
  assert.equal(S.form.task, 'Keep this task'); assert.equal(S.form.cwd, ''); assert.equal(S.form.continue, false);
  nodes = flatten(context.formView()); assert.ok(nodes.some(n => n.attrs?.name === 'cwd'));
  nodes.find(n => n.attrs?.name === 'runner').attrs.onchange({ target: { value: 'dok' } });
  nodes = flatten(context.formView()); nodes.find(n => n.tag === 'form').attrs.onsubmit({ preventDefault() {} });
  await pending;
  assert.equal(calls[0].name, 'start_selected_run'); assert.equal(calls[0].args.runner, 'dok');
  assert.equal(calls[0].args.request_id, 'request-form-test'); assert.equal(calls[0].args.cwd, undefined);
  assert.equal(calls[0].args.continue, undefined);
});

test('browser bridge rejects cross-site calls without its token and rejects wrong Host', async t => {
  const { server } = createUiServer({ token: 'fixture-token', ops: [] });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/call', { method: 'POST', headers: { origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
  const preflight = await fetch(base + '/call', { method: 'OPTIONS', headers: { origin: 'https://unrelated.example', 'access-control-request-headers': 'x-agent-ui' } });
  assert.equal(preflight.headers.has('access-control-allow-origin'), false);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(base + '/call', { method: 'POST', headers: { host: 'unrelated.example', 'x-agent-ui': 'fixture-token' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(wrongHost, 403);
});

test('hosted form persists request identity before admission and reuses it after reload', async () => {
  const html = dashboardHtml(), storage = new Map();
  const context = vm.createContext({ publicReview, publicationPending, publicationView: () => null, crypto: globalThis.crypto, TextEncoder, Uint8Array,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } });
  for (const name of ['hostedRequests', 'reserveHostedStart', 'resolveHostedStart']) {
    vm.runInContext(html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0], context);
  }
  const args = { agent: 'demo', task: 'A private task' };
  const first = await context.reserveHostedStart(args);
  assert.equal(await context.reserveHostedStart(args), first);
  assert.doesNotMatch([...storage.values()].join(''), /private task/);
  context.resolveHostedStart(first, { run_id: 'r-result' });
  assert.notEqual(await context.reserveHostedStart(args), first);
  context.localStorage.setItem = () => { throw Error('Storage unavailable'); };
  await assert.rejects(context.reserveHostedStart({ ...args, task: 'Another task' }), /Storage unavailable/);
});


test('publication view links only GitHub PRs and retries the saved run', async () => {
  const calls = [];
  const context = vm.createContext({ publicReview, S: { busy: new Set() },
    h: (tag, attrs, ...children) => ({ tag, attrs, children }),
    act: (_id, fn) => fn(), call: async (...args) => calls.push(args), loadDetail: async () => {}, refresh: async () => {} });
  vm.runInContext(dashboardHtml().match(/function publicationView\(r\) \{[\s\S]*?\n\}/)[0], context);
  const r = { run_id: 'saved-run', publication: { status: 'blocked', pr_url: 'javascript:alert(1)' } };
  let view = context.publicationView(r);
  assert.equal(view.children.some(c => c?.tag === 'a'), false);
  await view.children.find(c => c?.tag === 'button').attrs.onclick();
  assert.equal(calls[0][0], 'publish_review'); assert.equal(calls[0][1].run_id, 'saved-run');
  r.publication = { status: 'published', pr_url: 'https://github.com/plxzy/vm/pull/123' };
  view = context.publicationView(r);
  assert.equal(view.children.find(c => c?.tag === 'a').attrs.rel, 'noopener noreferrer');
  assert.equal(view.children.some(c => c?.tag === 'button'), false);
});
