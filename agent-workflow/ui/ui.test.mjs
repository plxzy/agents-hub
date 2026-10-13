import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import http from 'node:http';
import { healthOf, healthLabels } from '../health.mjs';
import { runTrace, failureRows } from '../run-trace.mjs';
import { bridgeScript, dashboardHtml } from './dashboard.mjs';
import { createUiServer } from './server.mjs';

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
  const context = vm.createContext({ healthOf, healthLabels,
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
  const context = vm.createContext({
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
  context.S.data.runs = [];
  context.scheduleRefresh();
  assert.equal(delays.pop(), 30000);
});

test('unknown Mac details refresh after contact returns and cannot be rated', () => {
  const html = dashboardHtml(), refreshed = [];
  const context = vm.createContext({
    S: { detail: { run_id: 'mac-run', agent: 'helper', status: 'unknown', error: 'Mac heartbeat expired' }, busy: new Set() },
    canDecide: () => true, list: () => null, runTrace, failureRows, loadDetail: id => refreshed.push(id), scheduleRefresh() {}, render() {},
    h: (tag, attrs, ...children) => ({ tag, attrs, children }),
  });
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
  const context = vm.createContext({ S: { detail: receipt, busy: new Set() }, runTrace, failureRows,
    canDecide: () => false, list: () => null, h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(html.match(/function detailView\(\) \{[\s\S]*?\n\}/)[0], context);
  const result = JSON.stringify(context.detailView());
  for (const [label, value] of runTrace(receipt)) { assert.ok(result.includes(label)); assert.ok(result.includes(value)); }
  assert.match(result, /Recorded run context/);
  assert.doesNotMatch(result, /innerHTML/);
  assert.ok(html.includes('globalThis.AgentsHealth = { healthOf, healthLabels, dashboardHealth, runTrace, failureRows };'));
  const bundled = vm.createContext({});
  const module = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].find((m) => m[1].includes('globalThis.AgentsHealth ='));
  vm.runInContext(module[1], bundled);
  assert.equal(JSON.stringify(bundled.AgentsHealth.runTrace(receipt)), JSON.stringify(runTrace(receipt)));
});

test('failed detail shows its error alongside labelled partial output and recorded diagnostics', () => {
  const html = dashboardHtml();
  const receipt = { run_id: 'r-failed', agent: 'helper', status: 'failed', error: 'model turn failed', output: 'Useful partial answer', output_partial: true,
    failure_context: { phase: 'model', last_tool: 'read', provider: 'openai', model: 'gpt-6-luna', message: '503 upstream disconnected' } };
  const context = vm.createContext({ S: { detail: receipt, busy: new Set() }, runTrace, failureRows,
    canDecide: () => false, list: () => null, h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  vm.runInContext(html.match(/function detailView\(\) \{[\s\S]*?\n\}/)[0], context);
  const result = JSON.stringify(context.detailView());
  for (const text of ['Error: model turn failed', 'Partial output', 'Useful partial answer', 'Last tool', 'read', '503 upstream disconnected']) assert.ok(result.includes(text), text);
  assert.deepEqual(failureRows({ status: 'failed', error: 'old receipt' }), []);
});

test('runner form defaults to dok, preserves the task, and clears incompatible fields', async () => {
  const html = dashboardHtml(), calls = []; let pending;
  const S = { data: { transport: 'mac', runner_selection: 1, run_targets: [
    { id: 'dok', available: true, agents: [{ name: 'demo', description: 'Remote', repo: 'demo', model: 'openai/gpt-6-luna' }] },
    { id: 'mac', available: true, agents: [{ name: 'demo', description: 'Local', workspace: 'here' }] },
  ] }, form: { task: 'Keep this task', cwd: '/private/project', continue: true }, busy: new Set() };
  const context = vm.createContext({ S, crypto: { randomUUID: () => 'request-form-test' }, canRun: () => true, allowedForRun: () => true,
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
