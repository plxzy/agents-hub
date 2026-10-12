import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch } from '../src/worker-core.mjs';

// Just enough of D1 for the probe's table.
function db() {
  const rows = new Map();
  return { rows, prepare(sql) {
    const stmt = (args = []) => ({
      async run() { if (sql.startsWith('INSERT')) rows.set(args[0], { id: args[0], at: args[1], kind: args[2], data: args[3] }); },
      async first() { return sql.startsWith('SELECT data FROM elicit_probe') ? rows.get(args[0]) ?? null : null; },
      async all() { return { results: [] }; },
    });
    return { ...stmt(), bind: (...args) => stmt(args) };
  } };
}
const rpc = (body, headers = {}) => new Request('https://x/mcp', { method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
const kinds = (env) => [...env.DB.rows.values()].map((r) => r.kind);

test('probe tool is listed only when ELICIT_PROBE is on', async () => {
  const off = await (await apiFetch(rpc({ id: 1, method: 'tools/list' }), { DB: db() })).json();
  assert.ok(!off.result.tools.some((t) => t.name === 'elicitation_probe'));
  const on = await (await apiFetch(rpc({ id: 1, method: 'tools/list' }), { DB: db(), ELICIT_PROBE: 'true' })).json();
  assert.ok(on.result.tools.some((t) => t.name === 'elicitation_probe'));
});

test('MRTR: input_required, then the retry carries the answer', async () => {
  const env = { DB: db(), ELICIT_PROBE: 'true' };
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } } };
  const first = await (await apiFetch(rpc({ id: 1, method: 'tools/call', params: { name: 'elicitation_probe', arguments: {}, _meta: meta } }), env)).json();
  assert.equal(first.result.resultType, 'input_required');
  const ask = first.result.inputRequests.decision;
  assert.deepEqual(ask.params.requestedSchema, { type: 'object', properties: {} });
  assert.ok(ask.params._meta['openai/elicitation'].requestedSchema.properties.decision);
  const retry = await (await apiFetch(rpc({ id: 2, method: 'tools/call', params: { name: 'elicitation_probe', arguments: {}, _meta: meta,
    requestState: first.result.requestState, inputResponses: { decision: { action: 'accept', content: { decision: 'reject' } } } } }), env)).json();
  assert.match(retry.result.content[0].text, /USER_ANSWER \(MRTR\).*"reject"/);
  assert.deepEqual(kinds(env).sort(), ['mrtr-answer', 'mrtr-ask']);
});

test('classic: request on the SSE stream, answer POSTed back, result on the same stream', async () => {
  const env = { DB: db(), ELICIT_PROBE: 'true' };
  await apiFetch(rpc({ id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-ai' }, capabilities: { elicitation: {} } } }), env);
  const res = await apiFetch(rpc({ id: 7, method: 'tools/call', params: { name: 'elicitation_probe', arguments: {} } }), env);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const ask = JSON.parse((await reader.read()).value.match(/data: (.*)/)[1]);
  assert.equal(ask.method, 'elicitation/create');
  const posted = await apiFetch(rpc({ id: ask.id, result: { action: 'accept', content: { decision: 'keep' } } }), env);
  assert.equal(posted.status, 202);
  let rest = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; rest += value; }
  const final = JSON.parse(rest.match(/data: (.*)/)[1]);
  assert.equal(final.id, 7);
  assert.match(final.result.content[0].text, /USER_ANSWER \(classic elicitation\/create\).*"keep"/);
  assert.ok(kinds(env).includes('initialize'));
});

test('classic without SSE says so instead of hanging', async () => {
  const env = { DB: db(), ELICIT_PROBE: 'true' };
  const body = await (await apiFetch(rpc({ id: 3, method: 'tools/call', params: { name: 'elicitation_probe' } }, { accept: 'application/json' }), env)).json();
  assert.match(body.result.content[0].text, /does not accept an SSE stream/);
});

test('classic: the Codex app gets openai/form without mode', async () => {
  const env = { DB: db(), ELICIT_PROBE: 'true' };
  const res = await apiFetch(rpc({ id: 9, method: 'tools/call', params: { name: 'elicitation_probe', arguments: {} } }, { 'user-agent': 'openai-mcp/1.0.0 (Codex)' }), env);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const ask = JSON.parse((await reader.read()).value.match(/data: (.*)/)[1]);
  assert.equal(ask.method, 'openai/form'); assert.equal(ask.params.mode, undefined);
  await apiFetch(rpc({ id: ask.id, result: { action: 'cancel' } }), env);
  for (;;) { const { done } = await reader.read(); if (done) break; }
});
