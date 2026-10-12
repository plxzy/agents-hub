import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { healthOf, healthLabels } from '../health.mjs';
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
    canDecide: () => true, list: () => null, loadDetail: id => refreshed.push(id), scheduleRefresh() {}, render() {},
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
