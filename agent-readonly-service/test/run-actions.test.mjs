import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { encode, PONG } from '../../agent-workflow/relay-wire.mjs';

test('chat run controls go to dok once per request and leave an audit receipt', async t => {
  const bundle = await build({ entryPoints: [new URL('./fixtures/hub-runtime.mjs', import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', external: ['cloudflare:workers'], platform: 'browser', loader: { '.html': 'text' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'actions-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], durableObjects: { RELAY: { className: 'AgentRelay', useSQLite: true } },
    bindings: { DOK_RELAY_TOKEN: 'dok-test', DEVELOPMENT_ENABLED: 'true' } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql'))) {
    for (const sql of fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const tool = async (name, args = {}) => (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const value = r => JSON.parse(r.content[0].text);
  const tools = (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })).json()).result.tools;
  for (const name of ['cancel_run', 'pause_run', 'dismiss_run', 'retry_inspection', 'list_run_actions']) {
    const advertised = tools.find(x => x.name === name);
    assert.ok(advertised, name); assert.notDeepEqual(advertised._meta?.ui?.visibility, ['app'], `${name} is callable from chat`);
  }
  const res = await mf.dispatchFetch('https://test/relay/dok-dev/connect', { headers: { upgrade: 'websocket', authorization: 'Bearer dok-test',
    'x-relay-hello': encode({ v: 1, session: 'actions-session', mode: 'acquire', status: { enabled: true, agents: ['workflow'] } }) } });
  const ws = res.webSocket, inbox = [], waiting = [];
  ws.accept(); ws.addEventListener('message', ({ data }) => { if (data === PONG) return; const m = JSON.parse(data); if (waiting.length) waiting.shift()(m); else inbox.push(m); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('No relay message')), 3000); waiting.push(m => { clearTimeout(timer); resolve(m); });
  });
  const hello = await next();
  const answer = (m, result) => ws.send(encode({ v: 1, session: 'actions-session', socket: hello.socket, type: 'result', attempt: m.attempt, id: m.id, result }));
  const id = 'r-20261014T190428Z-22dfa4', args = { run_id: id, request_id: 'dismiss-seed-0001', reason: 'redone by r-20261014T204047Z-63d458' };
  assert.equal((await tool('dismiss_run', { ...args, reason: "it's done" })).isError, true);
  assert.equal(inbox.length, 0, 'an invalid reason never dispatches');
  const pending = tool('dismiss_run', args);
  const request = await next();
  assert.equal(request.operation, 'run_control');
  assert.deepEqual(request.args, { run_id: id, request_id: args.request_id, action: 'dismiss', reason: args.reason });
  const before = { status: 'failed', recovery: { state: 'paused', retained: true, reason: 'Failure requires operator inspection before recovery' } };
  const after = { status: 'failed', recovery: { state: 'dismissed', retained: true, reason: 'Dismissed by operator' } };
  answer(request, { ok: true, value: { run_id: id, action: 'dismiss', before, after } }); await next();
  const receipt = value(await pending);
  assert.match(receipt.action_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...receipt, action_id: undefined, at: undefined },
    { action_id: undefined, at: undefined, run_id: id, action: 'dismiss', caller: 'mcp', reason: args.reason, before, after });
  assert.deepEqual(value(await tool('dismiss_run', args)), receipt, 'a repeated request returns the same receipt without dispatching');
  assert.equal(inbox.length, 0);
  assert.equal((await tool('cancel_run', args)).isError, true, 'a request id belongs to one action');
  assert.deepEqual(value(await tool('list_run_actions', { run_id: id })), { run_id: id, actions: [receipt] });
  const refused = tool('cancel_run', { run_id: id, request_id: 'cancel-seed-0001' });
  const cancel = await next(); answer(cancel, { ok: false, kind: 'terminal', error: 'Run is not active on this runner' }); await next();
  const failed = await refused;
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /not active/);
  assert.equal(value(await tool('list_run_actions', { run_id: id })).actions.length, 1, 'refused actions leave no receipt');
  ws.close();
});
