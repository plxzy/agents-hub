import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

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
  let response = await worker.fetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish', 'content-type': 'application/json' }, body: JSON.stringify({ agents: [{ name: 'helper' }], runs: [] }) }), env);
  assert.equal(response.status, 201);
  response = await worker.fetch(new Request('https://x/v1/agents', { headers: { authorization: 'Bearer read' } }), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).items[0].name, 'helper');
  response = await worker.fetch(new Request('https://x/v1/run_agent', { method: 'POST', headers: { authorization: 'Bearer read' } }), env);
  assert.equal(response.status, 404);
});

test('worker fails closed without the correct token', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish', READ_TOKEN: 'read' };
  const response = await worker.fetch(new Request('https://x/v1/agents'), env); assert.equal(response.status, 401);
});

test('MCP endpoint lists read-only tools and answers from the latest snapshot', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish', READ_TOKEN: 'read' };
  await worker.fetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish' }, body: JSON.stringify({ agents: [{ name: 'helper', tools: 'read, ls' }], runs: [{ run_id: 'r1', agent: 'helper', task: 'hi' }] }) }), env);
  let body = await (await worker.fetch(rpc({ id: 1, method: 'tools/list' }), env)).json();
  assert.deepEqual(body.result.tools.map((t) => t.name), ['list_agents', 'list_runs', 'get_run', 'get_status']);
  assert.ok(body.result.tools.every((t) => t.annotations.readOnlyHint));
  body = await (await worker.fetch(rpc({ id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} } }), env)).json();
  assert.deepEqual(JSON.parse(body.result.content[0].text).agents[0].tools, ['read', 'ls']);
  body = await (await worker.fetch(rpc({ id: 3, method: 'tools/call', params: { name: 'get_run', arguments: { run_id: 'r1' } } }, {}, 'https://x/mcp/read'), env)).json();
  assert.equal(JSON.parse(body.result.content[0].text).run.title, 'hi');
  assert.equal((await worker.fetch(rpc({ id: 4, method: 'tools/list' }, { authorization: 'Bearer nope' }), env)).status, 401);
  assert.equal((await worker.fetch(rpc({ id: 5, method: 'tools/list' }, {}, 'https://x/mcp/nope'), env)).status, 401);
  assert.equal((await worker.fetch(rpc({ method: 'notifications/initialized' }), env)).status, 202);
});

test('only the newest snapshots are kept', async () => {
  const env = { DB: db(), PUBLISH_TOKEN: 'publish', READ_TOKEN: 'read' };
  for (let i = 0; i < 25; i++) await worker.fetch(new Request('https://x/v1/snapshots', { method: 'POST', headers: { authorization: 'Bearer publish' }, body: '{}' }), env);
  assert.equal(env.DB.rows.length, 20);
});
