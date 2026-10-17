import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, defaultFetch } from '../src/worker-core.mjs';

// Answers every read with nothing: these tests cover routing and the tool surface; runs.test.mjs covers D1 reads.
function db() {
  const statement = { bind: () => statement, all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) };
  return { prepare: () => statement };
}
const rpc = (body, headers = { authorization: 'Bearer read' }, url = 'https://x/mcp') =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });

test('the retired snapshot routes are gone and only MCP is served', async () => {
  const env = { DB: db() };
  let response = await defaultFetch(new Request('https://x/v1/snapshots', { method: 'POST', body: '{}' }), env);
  assert.equal(response.status, 404);
  for (const path of ['/mcp/v1/agents', '/v1/runs', '/v1/run_agent']) assert.equal((await apiFetch(new Request('https://x' + path), env)).status, 404);
});

test('worker fails closed without the correct token', async () => {
  const env = { DB: db() };
  const response = await defaultFetch(new Request('https://x/v1/agents'), env); assert.equal(response.status, 404);
});

test('MCP endpoint lists read-only tools and serves the dashboard resource', async () => {
  const env = { DB: db() };
  let body = await (await apiFetch(rpc({ id: 1, method: 'tools/list' }), env, '<html/>')).json();
  assert.deepEqual(body.result.tools.map((t) => t.name), ['open_dashboard', 'get_status', 'list_agents', 'list_runs', 'get_run']);
  assert.ok(body.result.tools.every((t) => t.annotations.readOnlyHint));
  const dashboard = body.result.tools.find((t) => t.name === 'open_dashboard');
  assert.deepEqual(dashboard._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.ok(dashboard.icons[0].src.startsWith('data:image/svg+xml,'));
  const opened = await (await apiFetch(rpc({ id: 10, method: 'tools/call', params: { name: 'open_dashboard', arguments: {} } }), env)).json();
  assert.equal(opened.result.structuredContent.capabilities.run, false);
  assert.equal(opened.result.structuredContent.status.pending, null, 'an empty Hub says unknown, not zero');
  assert.match(opened.result.content[0].text, /not published|unknown/);
  const resource = await (await apiFetch(rpc({ id: 11, method: 'resources/read', params: { uri: dashboard._meta.ui.resourceUri } }), env, '<html/>')).json();
  assert.equal(resource.result.contents[0].text, '<html/>');
  assert.deepEqual(resource.result.contents[0]._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);
  body = await (await apiFetch(rpc({ id: 3, method: 'tools/call', params: { name: 'get_run', arguments: { run_id: 'r1' } } }), env)).json();
  assert.equal(body.result.isError, true);
  body = await (await apiFetch(rpc({ id: 4, method: 'resources/list' }), env)).json(); assert.equal(body.result.resources[0].uri, 'ui://agents-hub/dashboard-v14.html');
  assert.equal((await apiFetch(rpc({ method: 'notifications/initialized' }), env)).status, 202);
});
