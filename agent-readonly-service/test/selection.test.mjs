import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { encode, PONG } from '../../agent-workflow/relay-wire.mjs';

test('Mac selected starts use dok admission, scoped identity and read-only recovery', async t => {
  const bundle = await build({ entryPoints: [new URL('./fixtures/hub-runtime.mjs', import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', external: ['cloudflare:workers'], platform: 'browser', loader: { '.html': 'text' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'selection-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], durableObjects: { RELAY: { className: 'AgentRelay', useSQLite: true } },
    bindings: { DOK_RELAY_TOKEN: 'dok-test-only', MAC_TOKEN: 'mac-test-only', DEVELOPMENT_ENABLED: 'true' } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const f of ['0001_snapshots.sql', '0003_runs.sql', '0004_accounts.sql', '0005_decisions.sql', '0006_memory.sql', '0007_knowledge.sql']) {
    for (const sql of fs.readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const args = { agent: 'helper', task: 'Read README', request_id: 'selection-test-01' };
  const call = (route, body, token = 'mac-test-only') => mf.dispatchFetch('https://test/relay/mac/' + route, {
    method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('start', args, 'wrong')).status, 401);
  assert.equal((await call('start', args, 'dok-test-only')).status, 401);
  assert.equal((await call('start', args)).status, 409);
  for (const extra of [{ runner: 'mac' }, { model: 'openai/gpt-6-luna' }, { repo: 'other' }, { cwd: '/tmp' }, { confirm: 'anything' }]) {
    assert.equal((await call('start', { ...args, ...extra })).status, 400);
  }
  const selection = { version: 1, agents: [{ name: 'helper', repo: 'dev-workflow', model: 'openai/gpt-6-luna' }, { name: 'workflow', reason: 'Choose a repo' }] };
  const connection = await mf.dispatchFetch('https://test/relay/dok-dev/connect', { headers: { upgrade: 'websocket', authorization: 'Bearer dok-test-only',
    'x-relay-hello': encode({ v: 1, session: 'selection-session', mode: 'acquire', status: { enabled: true, agents: ['helper', 'workflow'], run_selection: selection } }) } });
  assert.equal(connection.status, 101);
  const ws = connection.webSocket, inbox = [], waiting = [];
  ws.accept(); ws.addEventListener('message', ({ data }) => { if (data === PONG) return; const m = JSON.parse(data); if (waiting.length) waiting.shift()(m); else inbox.push(m); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No socket message')), 5000); waiting.push(m => { clearTimeout(timer); resolve(m); });
  });
  const hello = await next();
  const send = m => ws.send(encode({ v: 1, session: 'selection-session', socket: hello.socket, ...m }));
  const panel = await (await call('panel')).json();
  assert.equal(panel.run_targets[0].id, 'dok'); assert.equal(panel.run_targets[0].available, true);
  assert.equal('confirm' in panel, false);
  assert.equal((await call('start', { ...args, agent: 'workflow' })).status, 409);
  assert.equal((await call('start', { ...args, agent: 'other' })).status, 409);
  const first = call('start', args), second = call('start', args);
  const m = await next(); assert.equal(m.operation, 'run_start'); assert.equal(m.args.request_id, 'mac-selection-test-01');
  assert.deepEqual(Object.keys(m.args).sort(), ['agent', 'request_id', 'task']);
  assert.equal((await (await call('starts/' + args.request_id)).json()).state, 'pending');
  assert.equal((await (await call('panel')).json()).relay.pending_starts, 1);
  const running = { run_id: 'r-20261013T010000Z-abcdef', request_id: m.args.request_id, agent: 'helper', runner: 'dok', status: 'running', started: new Date().toISOString() };
  send({ type: 'result', attempt: m.attempt, id: m.id, result: { ok: true, value: running } });
  assert.equal((await next()).type, 'ack');
  assert.equal((await (await first).json()).run_id, running.run_id);
  assert.equal((await (await second).json()).run_id, running.run_id);
  assert.equal(inbox.length, 0, 'concurrent duplicate caused no second dispatch');
  assert.equal((await (await call('panel')).json()).relay.pending_starts, 0);
  const recovered = await (await call('starts/' + args.request_id)).json();
  assert.equal(recovered.state, 'started'); assert.equal(recovered.run_id, running.run_id);
  const lookup = call('starts/missing-from-hub');
  const q = await next(); assert.equal(q.operation, 'run_lookup'); assert.equal(q.args.target_request_id, 'mac-missing-from-hub');
  send({ type: 'result', attempt: q.attempt, id: q.id, result: { ok: true, value: { state: 'not_found' } } });
  assert.equal((await next()).type, 'ack'); assert.equal((await (await lookup).json()).state, 'not_found');
  // Eligibility changed after the form's earlier observation; admission must reject it now.
  send({ type: 'status', status: { enabled: false, agents: ['helper'], run_selection: { version: 1, agents: [selection.agents[0]] } } });
  for (let n = 0; n < 20; n++) { if (!(await (await call('panel')).json()).run_targets[0].available) break; }
  assert.equal((await call('start', { ...args, request_id: 'selection-new-id' })).status, 409);
  ws.close();
});
