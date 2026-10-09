import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

function db() {
  const rows = [];
  return { rows, prepare(sql) {
    return {
      bind(...args) { return { async run() { rows.push({ id: args[0], published_at: args[1], payload: args[2] }); } }; },
      async first() { return rows.at(-1) ?? null; },
    };
  } };
}

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
