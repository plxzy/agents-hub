import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { encode, PONG } from '../../agent-workflow/relay-wire.mjs';
import { sanitizeReceipt } from '../src/runs.mjs';

const DOK = 'dok-test-only';
const RUN = 'r-20261012T120000Z-abcdef';

test('receipts keep useful fields, drop unknown ones and redact secret-looking lines', () => {
  const r = sanitizeReceipt({ run_id: RUN, agent: 'helper', status: 'completed', started: '2026-10-12T12:00:00.000Z', task: 'Where?\nmore',
    output: 'src/access.mjs:9\napi_key = sk-abcdefghijklmnopqrstuv', tool_calls: ['read', 'bad name'], usage: { totalTokens: 10, cost: 0.01 },
    reported_at: 1, host_path: '/home/x' }, 'dok');
  assert.equal(r.title, 'Where?'); assert.equal(r.runner, 'dok');
  assert.match(r.output, /src\/access\.mjs:9\n\[redacted line/); assert.doesNotMatch(r.output, /sk-/);
  assert.deepEqual(r.tool_calls, ['read']); assert.equal(r.reported_at, undefined); assert.equal(r.host_path, undefined);
  assert.throws(() => sanitizeReceipt({ run_id: 'x', agent: 'helper', status: 'completed', started: 'now' }, 'dok'), /Invalid/);
});

test('start_run goes to dok, receipts land in D1 and stay readable', async (t) => {
  const bundle = await build({ entryPoints: [new URL('./fixtures/hub-runtime.mjs', import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', external: ['cloudflare:workers'], platform: 'browser', loader: { '.html': 'text' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'hub-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], durableObjects: { RELAY: { className: 'AgentRelay', useSQLite: true } },
    bindings: { DOK_RELAY_TOKEN: DOK, DEVELOPMENT_ENABLED: 'true' } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of ['0001_snapshots.sql', '0003_runs.sql']) {
    for (const sql of fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const tool = async (name, args = {}) => (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const post = (body, token = DOK) => mf.dispatchFetch('https://test/relay/dok-dev/runs', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });

  const listed = (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST', body: JSON.stringify({ id: 1, method: 'tools/list' }) })).json()).result.tools.map((x) => x.name);
  assert.ok(listed.includes('start_run') && listed.includes('get_remote_run')); assert.ok(!listed.includes('panel_data'));
  assert.match((await tool('start_run', { agent: 'helper', task: 'x', request_id: 'request-0000' })).content[0].text, /No runner is online/);

  const res = await mf.dispatchFetch('https://test/relay/dok-dev/connect', { headers: { upgrade: 'websocket', authorization: 'Bearer ' + DOK,
    'x-relay-hello': encode({ v: 1, session: 'dok-session-1', mode: 'acquire', status: { enabled: true, agents: ['workflow', 'helper'] } }) } });
  assert.equal(res.status, 101);
  const ws = res.webSocket, inbox = [], waiting = [];
  ws.accept(); ws.addEventListener('message', ({ data }) => { if (data === PONG) return; const m = JSON.parse(data); if (waiting.length) waiting.shift()(m); else inbox.push(m); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiting.push(r));
  const hello = await next();

  const started = tool('start_run', { agent: 'helper', task: 'Where is the JWT checked?', request_id: 'request-0001' });
  const m = await next();
  assert.equal(m.operation, 'run_start'); assert.deepEqual(m.args, { request_id: 'request-0001', agent: 'helper', task: 'Where is the JWT checked?' });
  const running = { run_id: RUN, agent: 'helper', kind: 'task', runner: 'dok', status: 'running', task: 'Where is the JWT checked?', started: '2026-10-12T12:00:00.000Z', model: 'openai/gpt-6-luna' };
  ws.send(encode({ v: 1, session: 'dok-session-1', socket: hello.socket, type: 'result', attempt: m.attempt, id: m.id, result: { ok: true, value: running } }));
  const start = JSON.parse((await started).content[0].text);
  assert.equal(start.run_id, RUN); assert.equal(start.runner, 'dok'); assert.match(start.next_step, /get_run/);
  assert.equal(JSON.parse((await tool('get_run', { run_id: RUN })).content[0].text).status, 'running');

  assert.equal((await post({ ...running, status: 'completed' }, 'wrong-token')).status, 401);
  assert.equal((await post({ ...running, status: 'completed', ended: '2026-10-12T12:01:00.000Z', output: 'agent-readonly-service/src/access.mjs:9' })).status, 200);
  assert.equal((await post(running)).status, 200); // a late running receipt never replaces the final one
  const done = JSON.parse((await tool('get_remote_run', { run_id: RUN })).content[0].text);
  assert.equal(done.status, 'completed'); assert.match(done.output, /access\.mjs:9/);
  assert.equal(JSON.parse((await tool('list_runs')).content[0].text).runs.at(-1).runner, 'dok');

  assert.match((await tool('start_run', { agent: 'network', task: 'x', request_id: 'request-0002' })).content[0].text, /dok does not run network; it offers: helper/);
  assert.match((await tool('start_run', { agent: 'workflow', task: 'x', request_id: 'request-0003' })).content[0].text, /request_development/);
  assert.equal((await post({ run_id: 'bad' })).status, 400);
  ws.close();
});
