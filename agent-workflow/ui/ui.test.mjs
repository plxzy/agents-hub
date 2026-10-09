import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
