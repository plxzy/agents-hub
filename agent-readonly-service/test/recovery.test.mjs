import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { encode, PONG } from '../../agent-workflow/relay-wire.mjs';

test('hosted recovery reconciles identities and requires checkpoint-bound private approval', async t => {
  const bundle = await build({ entryPoints: [new URL('./fixtures/hub-runtime.mjs', import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', external: ['cloudflare:workers'], platform: 'browser', loader: { '.html': 'text' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'recovery-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], durableObjects: { RELAY: { className: 'AgentRelay', useSQLite: true } },
    bindings: { DOK_RELAY_TOKEN: 'dok-test', DEVELOPMENT_ENABLED: 'true' } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of ['0001_snapshots.sql', '0003_runs.sql', '0004_accounts.sql', '0005_decisions.sql', '0006_memory.sql', '0007_knowledge.sql']) {
    for (const sql of fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const tool = async (name, args = {}) => (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const value = r => JSON.parse(r.content[0].text);
  assert.equal(value(await tool('get_start_status', { request_id: 'never-admitted' })).state, 'unknown');
  const res = await mf.dispatchFetch('https://test/relay/dok-dev/connect', { headers: { upgrade: 'websocket', authorization: 'Bearer dok-test',
    'x-relay-hello': encode({ v: 1, session: 'recovery-session', mode: 'acquire', status: { enabled: true, agents: ['workflow'] } }) } });
  const ws = res.webSocket, inbox = [], waiting = [];
  ws.accept(); ws.addEventListener('message', ({ data }) => { if (data === PONG) return; const m = JSON.parse(data); if (waiting.length) waiting.shift()(m); else inbox.push(m); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('No relay message')), 3000); waiting.push(m => { clearTimeout(timer); resolve(m); });
  });
  const hello = await next();
  const answer = (m, result) => ws.send(encode({ v: 1, session: 'recovery-session', socket: hello.socket, type: 'result', attempt: m.attempt, id: m.id, result }));
  const unknown = tool('get_start_status', { request_id: 'never-admitted' });
  const lookup = await next(); assert.equal(lookup.operation, 'run_lookup');
  answer(lookup, { ok: true, value: { state: 'not_found' } }); await next();
  assert.equal(value(await unknown).state, 'unknown');
  const id = 'r-20261013T000000Z-abcdef';
  await mf.dispatchFetch('https://test/relay/dok-dev/runs', { method: 'POST', headers: { authorization: 'Bearer dok-test' }, body: JSON.stringify({
    run_id: id, request_id: 'original-request', agent: 'workflow', status: 'interrupted', started: new Date().toISOString(),
    recovery: { state: 'awaiting_review', checkpoint_version: 7, retained: true, inspection: 'Saved file is partly edited.', raw: 'private' } }) });
  assert.equal(value(await tool('get_start_status', { request_id: 'original-request' })).run_id, id);
  const panel = await tool('panel_data'), key = `${id}:7`, code = panel._meta['agents-hub/confirm'].recovery[key];
  assert.ok(code); assert.equal(panel.content[0].text.includes(code), false);
  assert.equal(value(await tool('get_run', { run_id: id })).recovery.raw, undefined);
  const args = { run_id: id, request_id: 'resume-request', checkpoint_version: 7 };
  assert.equal((await tool('resume_run', { ...args, approved: true })).isError, true);
  assert.equal((await tool('decide_recovery', { ...args, checkpoint_version: 8, confirm: code })).isError, true);
  assert.equal((await tool('decide_recovery', { ...args, confirm: 'x'.repeat(24) })).isError, true);
  assert.equal(inbox.length, 0, 'invalid approval must not dispatch');
  const resumed = tool('decide_recovery', { ...args, confirm: code });
  const request = await next(); assert.equal(request.operation, 'run_resume'); assert.equal(request.args.approved, true);
  const nextId = 'r-20261013T000001Z-123abc';
  answer(request, { ok: true, value: { run_id: nextId, request_id: args.request_id, agent: 'workflow', runner: 'dok', status: 'running',
    started: new Date().toISOString(), workspace: '/private', recovery: { state: 'ready', resumed_from: id } } });
  await next(); const result = value(await resumed); assert.equal(result.run_id, nextId); assert.equal(result.workspace, undefined);
  assert.equal((await tool('decide_recovery', { ...args, confirm: code })).isError, true);
  assert.equal(value(await tool('get_start_status', { request_id: args.request_id })).run_id, nextId);
  assert.equal(value(await tool('get_run', { run_id: id })).status, 'interrupted');
  const publish = revision => mf.dispatchFetch('https://test/relay/dok-dev/runs', { method: 'POST', headers: { authorization: 'Bearer dok-test' }, body: JSON.stringify({
    run_id: id, request_id: 'original-request', agent: 'workflow', status: 'interrupted', started: new Date().toISOString(),
    recovery: { state: revision === 3 ? 'resumed' : 'ready', revision, checkpoint_version: 7, retained: true, ...(revision === 3 ? { resumed_by: nextId } : {}) } }) });
  await publish(3); await publish(2);
  assert.equal(value(await tool('get_run', { run_id: id })).recovery.resumed_by, nextId, 'late receipt cannot erase a newer resume link');
  ws.close();
});
