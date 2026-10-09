import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, defaultFetch } from '../src/worker-core.mjs';

function db() {
  const rows = [];
  return { rows, prepare(sql) {
    return {
      bind(...args) { return { async run() {
        if (sql.startsWith('INSERT')) rows.push({ id: args[0], published_at: args[1], payload: args[2] });
        else if (sql.startsWith('DELETE')) rows.splice(0, Math.max(rows.length - args[0], 0));
      } }; },
      async first() { return rows.at(-1) ?? null; },
    };
  } };
}
const rpc = (body, headers = { authorization: 'Bearer read' }, url = 'https://x/mcp') =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });

test('worker publishes and serves only read endpoints', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish', READ_TOKEN: 'read' };
  let response = await defaultFetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish', 'content-type': 'application/json' }, body: JSON.stringify({ agents: [{ name: 'helper' }], runs: [] }) }), env);
  assert.equal(response.status, 201);
  response = await apiFetch(new Request('https://x/mcp/v1/agents'), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).items[0].name, 'helper');
  response = await apiFetch(new Request('https://x/v1/run_agent', { method: 'POST' }), env);
  assert.equal(response.status, 404);
});

test('worker fails closed without the correct token', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish', READ_TOKEN: 'read' };
  const response = await defaultFetch(new Request('https://x/v1/agents'), env); assert.equal(response.status, 404);
});

test('MCP endpoint lists read-only tools and answers from the latest snapshot', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish', READ_TOKEN: 'read' };
  await defaultFetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish' }, body: JSON.stringify({ agents: [{ name: 'helper', tools: 'read, ls' }], runs: [{ run_id: 'r1', agent: 'helper', task: 'hi' }] }) }), env);
  let body = await (await apiFetch(rpc({ id: 1, method: 'tools/list' }), env, '<html/>')).json();
  assert.deepEqual(body.result.tools.map((t) => t.name), ['open_dashboard', 'get_status', 'list_agents', 'list_runs', 'get_run', 'resolve_context']);
  assert.ok(body.result.tools.every((t) => t.annotations.readOnlyHint));
  const dashboard = body.result.tools.find((t) => t.name === 'open_dashboard');
  assert.deepEqual(dashboard._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.ok(dashboard.icons[0].src.startsWith('data:image/svg+xml,'));
  const opened = await (await apiFetch(rpc({ id: 10, method: 'tools/call', params: { name: 'open_dashboard', arguments: {} } }), env)).json();
  assert.equal(opened.result.structuredContent.capabilities.run, false);
  assert.equal(opened.result.structuredContent.agents[0].name, 'helper');
  const resource = await (await apiFetch(rpc({ id: 11, method: 'resources/read', params: { uri: dashboard._meta.ui.resourceUri } }), env, '<html/>')).json();
  assert.equal(resource.result.contents[0].text, '<html/>');
  assert.deepEqual(resource.result.contents[0]._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);
  body = await (await apiFetch(rpc({ id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} } }), env)).json();
  assert.deepEqual(JSON.parse(body.result.content[0].text).agents[0].tools, ['read', 'ls']);
  body = await (await apiFetch(rpc({ id: 3, method: 'tools/call', params: { name: 'get_run', arguments: { run_id: 'r1' } } }), env)).json();
  assert.equal(JSON.parse(body.result.content[0].text).title, 'hi');
  body = await (await apiFetch(rpc({ id: 4, method: 'resources/list' }), env)).json(); assert.equal(body.result.resources[0].uri, 'ui://agents-hub/dashboard-v2.html');
  assert.equal((await apiFetch(rpc({ method: 'notifications/initialized' }), env)).status, 202);
});

test('only the newest snapshots are kept', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish', READ_TOKEN: 'read' };
  for (let i = 0; i < 25; i++) await defaultFetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish' }, body: '{}' }), env);
  assert.equal(env.DB.rows.length, 20);
});

test('hosted results follow the shared contract the dashboard reads', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish' };
  const { sanitizeSnapshot } = await import('../src/snapshot.mjs');
  // What publisher.mjs sends: already sanitized once.
  const sent = sanitizeSnapshot({ generated_at: new Date().toISOString(), agents: [{ name: 'helper' }], pending: { memory: 2, proposals: 1 },
    runs: [{ run_id: 'r1', agent: 'helper', status: 'completed', task: 'List tools\nprivate', tool_calls: ['read', 'ls'], usage: { totalTokens: 9, cost: 0.5 }, feedback: { rating: 'good' } }] });
  await defaultFetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish' }, body: JSON.stringify(sent) }), env);
  let body = await (await apiFetch(rpc({ id: 1, method: 'tools/call', params: { name: 'open_dashboard', arguments: {} } }), env)).json();
  const d = body.result.structuredContent;
  assert.deepEqual(d.status.pending, { memory: 2, proposals: 1 });
  assert.equal(d.pending, null); assert.equal(d.capabilities.run, false);
  assert.equal(d.snapshot.stale, false); assert.ok(d.snapshot.published_at);
  assert.equal(d.agents[0].last_run.run_id, 'r1');
  assert.match(body.result.content[0].text, /2 memory note\(s\) and 1 proposal/);
  body = await (await apiFetch(rpc({ id: 2, method: 'tools/call', params: { name: 'get_run', arguments: { run_id: 'r1' } } }), env)).json();
  const run = JSON.parse(body.result.content[0].text);
  assert.equal(run.agent, 'helper'); assert.equal(run.title, 'List tools');
  assert.equal(run.tool_calls, 2); assert.equal(run.tokens, 9); assert.equal(run.cost_usd, 0.5); assert.equal(run.feedback, 'good');
  assert.equal('task' in run, false);
});

test('a snapshot without review counts says unknown, not zero', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish' };
  await defaultFetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish' }, body: JSON.stringify({ agents: [], runs: [] }) }), env);
  const body = await (await apiFetch(rpc({ id: 1, method: 'tools/call', params: { name: 'open_dashboard', arguments: {} } }), env)).json();
  assert.equal(body.result.structuredContent.status.pending, null);
  assert.match(body.result.content[0].text, /not published/);
});
