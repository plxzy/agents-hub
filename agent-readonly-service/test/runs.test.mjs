import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { encode, PONG } from '../../agent-workflow/relay-wire.mjs';
import { sanitizeReceipt, observedRun, MAC_HEARTBEAT_TTL_MS } from '../src/runs.mjs';

const DOK = 'dok-test-only';
const RUN = 'r-20261012T120000Z-abcdef';

test('failure evidence survives Hub sanitization without leaking nested raw fields', () => {
  const r = sanitizeReceipt({ run_id: RUN, agent: 'helper', status: 'failed', started: '2026-10-12T12:00:00Z', output_partial: true,
    output: 'Useful partial output', failure_context: { phase: 'model', last_tool: 'read', provider: 'openai', model: 'gpt-6-luna',
      message: '503 connection dropped\nAuthorization: Bearer credential\n/home/name/private/file', stack: 'private stack', args: { token: 'private' } } }, 'dok');
  assert.equal(r.failure_context.phase, 'model'); assert.equal(r.failure_context.last_tool, 'read');
  assert.match(r.failure_context.message, /503 connection dropped/);
  assert.doesNotMatch(JSON.stringify(r.failure_context), /credential|\/home|private|stack|token/);
  assert.equal(r.output_partial, true); assert.equal(r.output, 'Useful partial output');
  const success = sanitizeReceipt({ ...r, status: 'completed' }, 'dok');
  assert.equal(success.failure_context, undefined); assert.equal(success.output_partial, undefined);
});

test('Mac liveness uses the Hub observation time and never invents completion', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  const row = { receipt: JSON.stringify({ run_id: RUN, runner: 'mac', status: 'running' }), updated_at: new Date(now).toISOString() };
  assert.equal(observedRun(row, now).status, 'running');
  const stale = observedRun(row, now + MAC_HEARTBEAT_TTL_MS);
  assert.equal(stale.status, 'unknown'); assert.equal(stale.ended, undefined); assert.match(stale.error, /may still be active/);
  assert.equal(JSON.parse(row.receipt).status, 'running', 'projection leaves stored state recoverable');
  assert.equal(observedRun({ ...row, updated_at: 'bad' }, now).status, 'unknown');
  assert.equal(observedRun(row, now - 1).status, 'unknown');
  for (const receipt of [{ runner: 'dok', status: 'running' }, { runner: 'mac', status: 'completed' }]) {
    assert.equal(observedRun({ ...row, receipt: JSON.stringify(receipt) }, now + MAC_HEARTBEAT_TTL_MS).status, receipt.status);
  }
});

test('receipts keep useful fields, drop unknown ones and redact secret-looking lines', () => {
  const r = sanitizeReceipt({ run_id: RUN, agent: 'helper', status: 'completed', started: '2026-10-12T12:00:00.000Z', task: 'Where?\nmore',
    output: 'src/access.mjs:9\napi_key = sk-abcdefghijklmnopqrstuv', tool_calls: ['read', 'bad name'], usage: { totalTokens: 10, cost: 0.01 },
    reported_at: 1, host_path: '/home/x' }, 'dok');
  assert.equal(r.title, 'Where?'); assert.equal(r.runner, 'dok');
  assert.match(r.output, /src\/access\.mjs:9\n\[redacted line/); assert.doesNotMatch(r.output, /sk-/);
  assert.deepEqual(r.tool_calls, ['read']); assert.equal(r.reported_at, undefined); assert.equal(r.host_path, undefined);
  assert.throws(() => sanitizeReceipt({ run_id: 'x', agent: 'helper', status: 'completed', started: 'now' }, 'dok'), /Invalid/);
});

test('receipt configuration keeps model thinking and bounded MCP observations only', () => {
  const r = sanitizeReceipt({ run_id: RUN, agent: 'helper', status: 'completed', started: '2026-10-12T12:00:00.000Z',
    runtime: { provider: 'openai', model: 'gpt-6-luna', thinking: 'high', mcp: { status: 'disabled', source: 'pi-launcher --no-mcp' }, conversation_id: 'private' },
    configuration: { mcp_connection: { protocol_version: '2026-07-28', capabilities: { elicitation: { form: {} }, tools: { listChanged: true } }, source: 'local-mcp-initialize', client: { name: 'fixture' } } } }, 'mac');
  assert.equal(r.runtime.model, 'gpt-6-luna'); assert.equal(r.runtime.thinking, 'high');
  assert.equal(r.runtime.conversation_id, undefined); assert.equal(r.runtime.mcp.status, 'disabled');
  assert.equal(r.configuration.mcp_connection.protocol_version, '2026-07-28');
  assert.equal(r.configuration.mcp_connection.capabilities.elicitation.form?.toString(), '[object Object]');
});

test('hosted receipts preserve the checkout branch but never publish private paths', () => {
  const r = sanitizeReceipt({ run_id: RUN, agent: 'helper', status: 'completed', started: '2026-10-12T12:00:00.000Z',
    repo: 'dev-workflow', checkout_branch: 'main', workspace: '/home/dok/run-work/private/workspace', log_path: '/home/dok/run.log' }, 'dok');
  assert.equal(r.checkout_branch, 'main');
  assert.equal(r.workspace, undefined); assert.equal(r.log_path, undefined);
});

test('start_run goes to dok, receipts land in D1 and stay readable', async (t) => {
  const bundle = await build({ entryPoints: [new URL('./fixtures/hub-runtime.mjs', import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', external: ['cloudflare:workers'], platform: 'browser', loader: { '.html': 'text' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'hub-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], durableObjects: { RELAY: { className: 'AgentRelay', useSQLite: true } },
    bindings: { DOK_RELAY_TOKEN: DOK, MAC_TOKEN: 'mac-secret-token', DEVELOPMENT_ENABLED: 'true' } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of ['0001_snapshots.sql', '0003_runs.sql', '0004_accounts.sql', '0005_decisions.sql', '0006_memory.sql', '0007_knowledge.sql', '0011_runs_archived.sql']) {
    for (const sql of fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const tool = async (name, args = {}) => (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const post = (body, token = DOK) => mf.dispatchFetch('https://test/relay/dok-dev/runs', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const dokGet = (route, token = DOK) => mf.dispatchFetch('https://test/relay/dok-dev/' + route, { headers: { authorization: 'Bearer ' + token } });

  const listed = (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST', body: JSON.stringify({ id: 1, method: 'tools/list' }) })).json()).result.tools.map((x) => x.name);
  assert.ok(listed.includes('start_run') && listed.includes('get_remote_run')); assert.ok(listed.includes('panel_data') && listed.includes('rate_run') && listed.includes('review_decide'));
  assert.match((await tool('start_run', { agent: 'helper', task: 'x', request_id: 'request-0000' })).content[0].text, /No runner is online/);

  const res = await mf.dispatchFetch('https://test/relay/dok-dev/connect', { headers: { upgrade: 'websocket', authorization: 'Bearer ' + DOK,
    'x-relay-hello': encode({ v: 1, session: 'dok-session-1', mode: 'acquire', status: { enabled: true, agents: ['workflow', 'helper'] } }) } });
  assert.equal(res.status, 101);
  const ws = res.webSocket, inbox = [], waiting = [];
  ws.accept(); ws.addEventListener('message', ({ data }) => { if (data === PONG) return; const m = JSON.parse(data); if (waiting.length) waiting.shift()(m); else inbox.push(m); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiting.push(r));
  const hello = await next();

  const status = JSON.parse((await tool('get_status')).content[0].text);
  assert.equal(Object.keys(status)[0], 'start_run'); assert.equal(status.start_run.available, true);
  assert.deepEqual(status.start_run.runners, { dok: ['workflow', 'helper'] }); assert.equal(status.capabilities.run, true);
  assert.equal(status.health.execution.available, true); assert.match(status.health.execution.reason, /dok runner online/);
  const started = tool('start_run', { agent: 'helper', task: 'Where is the JWT checked?', request_id: 'request-0001' });
  const m = await next();
  assert.equal(m.operation, 'run_start'); assert.deepEqual(m.args, { request_id: 'request-0001', agent: 'helper', task: 'Where is the JWT checked?' });
  const running = { run_id: RUN, agent: 'helper', kind: 'task', runner: 'dok', status: 'running', task: 'Where is the JWT checked?', started: '2026-10-12T12:00:00.000Z', model: 'openai/gpt-6-luna' };
  ws.send(encode({ v: 1, session: 'dok-session-1', socket: hello.socket, type: 'result', attempt: m.attempt, id: m.id, result: { ok: true, value: running } }));
  const start = JSON.parse((await started).content[0].text);
  assert.equal(start.run_id, RUN); assert.equal(start.runner, 'dok'); assert.match(start.next_step, /get_run/);
  assert.equal(JSON.parse((await tool('get_run', { run_id: RUN })).content[0].text).status, 'running');

  const progress = { phase: 'tool', action: 'tool_started', last_tool: 'read', observed_at: '2026-10-12T12:00:05.000Z' };
  assert.equal((await post({ ...running, progress: { ...progress, args: 'private', output: 'private' } })).status, 200);
  const live = JSON.parse((await tool('get_run', { run_id: RUN })).content[0].text);
  assert.deepEqual(live.progress, progress);
  assert.deepEqual(JSON.parse((await tool('panel_data')).content[0].text).runs.at(-1).progress, progress);
  const macView = await mf.dispatchFetch(`https://test/relay/mac/runs/${RUN}`, { headers: { authorization: 'Bearer mac-secret-token' } });
  assert.deepEqual((await macView.json()).progress, progress);
  await post({ ...running, progress: { ...progress, observed_at: '2026-10-12T12:00:01Z', last_tool: 'ls' } });
  await post(running); // initial acknowledgement arriving after telemetry cannot erase progress
  assert.deepEqual(JSON.parse((await tool('get_run', { run_id: RUN })).content[0].text).progress, progress);

  assert.equal((await post({ ...running, status: 'completed' }, 'wrong-token')).status, 401);
  assert.equal((await post({ ...running, status: 'completed', ended: '2026-10-12T12:01:00.000Z', output: 'agent-readonly-service/src/access.mjs:9' })).status, 200);
  assert.equal((await post(running)).status, 200); // a late running receipt never replaces the final one
  const done = JSON.parse((await tool('get_remote_run', { run_id: RUN })).content[0].text);
  assert.equal(done.status, 'completed'); assert.match(done.output, /access\.mjs:9/);
  assert.equal(JSON.parse((await tool('list_runs')).content[0].text).runs.at(-1).runner, 'dok');

  // The panel works without the Mac: data and one-time codes come from the Hub; the model's text never carries a code.
  const panel = await tool('panel_data');
  const codes = panel._meta['agents-hub/confirm'];
  assert.ok(codes.rate[RUN] && codes.rate[RUN].length >= 20); assert.deepEqual(codes.review, {});
  assert.doesNotMatch(panel.content[0].text, new RegExp(codes.rate[RUN]));
  const view = JSON.parse(panel.content[0].text);
  await t.test('panel agent count follows its returned list, not the retired snapshot', async () => {
    await db.prepare('INSERT INTO snapshots (id, published_at, payload) VALUES (?, ?, ?)').bind('old', '2026-10-01T00:00:00Z',
      JSON.stringify({ generated_at: '2026-10-01T00:00:00Z', agents: [{ name: 'helper' }], runs: [] })).run();
    const refreshed = JSON.parse((await tool('panel_data')).content[0].text);
    assert.deepEqual(refreshed.agents.map((a) => a.name).sort(), ['helper', 'workflow']);
    assert.equal(refreshed.status.agents, refreshed.agents.length);
    await db.prepare('DELETE FROM snapshots WHERE id = ?').bind('old').run();
  });
  assert.equal(view.relay.online, true); assert.equal(view.relay.runner, 'dok'); assert.equal(view.capabilities.mutate, true);
  assert.ok(view.runs.some((r) => r.run_id === RUN)); assert.ok(view.agents.some((a) => a.name === 'helper' && a.remote_allowed));
  assert.equal(JSON.parse((await tool('panel_run', { run_id: RUN })).content[0].text).status, 'completed');
  const rate = (args) => tool('rate_run', { run_id: RUN, rating: 'good', request_id: 'rate-request-1', ...args });
  assert.match((await rate({})).content[0].text, /Invalid|Missing/); // schema: confirm is required
  assert.match((await rate({ confirm: 'x'.repeat(24) })).content[0].text, /needs a click in the Agents Hub panel/);
  assert.match((await rate({ confirm: codes.rate[RUN], comment: 'Right file, token sk-abcdefghijklmnopqrstuvwxyz0123 leaked' })).content[0].text, /rated r-/);
  assert.match((await rate({ confirm: codes.rate[RUN] })).content[0].text, /needs a click/); // a code works once
  const rated = JSON.parse((await tool('get_run', { run_id: RUN })).content[0].text);
  assert.equal(rated.feedback.rating, 'good'); assert.match(rated.feedback.comment, /redacted line/);
  assert.equal(JSON.parse((await tool('list_runs')).content[0].text).runs.find((r) => r.run_id === RUN).feedback, 'good');
  assert.equal(JSON.parse((await tool('panel_data')).content[0].text).runs.find((r) => r.run_id === RUN).feedback, 'good');
  assert.equal((await tool('rate_run', { run_id: 'r-20261012T120000Z-ffffff', rating: 'good', request_id: 'rate-request-2', confirm: 'y'.repeat(24) })).isError, true); // unknown run: no Mac, no rating
  // The Mac is its own principal: it posts receipts (chat/eval kinds, blocked counts), reads bundle, pending and decisions.
  const mac = (route, init = {}, token = 'mac-secret-token') => mf.dispatchFetch('https://test/relay/mac/' + route, { ...init, headers: { authorization: 'Bearer ' + token } });
  const CHAT = 'c-20261012T130000Z-abcdef';
  const chat = { run_id: CHAT, agent: 'workflow', kind: 'chat', status: 'completed', started: '2026-10-12T13:00:00.000Z', task: 'Talk', blocked: [{ x: 1 }, { x: 2 }], commands: ['rm -rf /'], workspace: '/Users/x', output: 'ok' };
  assert.equal((await mac('runs', { method: 'POST', body: JSON.stringify(chat) })).status, 200);
  assert.equal((await mac('runs', { method: 'POST', body: JSON.stringify(chat) }, 'wrong')).status, 401);
  assert.equal((await mac('runs', { method: 'POST', body: JSON.stringify(chat) }, DOK)).status, 401); // the dok token is not the Mac's
  assert.equal((await post(chat, 'mac-secret-token')).status, 401); // and the Mac token does not reach dok routes
  const macRun = JSON.parse((await tool('get_run', { run_id: CHAT })).content[0].text);
  assert.equal(macRun.kind, 'chat'); assert.equal(macRun.runner, 'mac'); assert.equal(macRun.blocked, 2); assert.equal(macRun.commands, undefined); assert.equal(macRun.workspace, undefined);
  assert.equal((await mac('bundle?scopes=shared')).status, 200);
  assert.ok(Array.isArray((await (await mac('pending')).json()).pending));
  const dec = await (await mac('decisions?since=2000-01-01T00:00:00Z')).json();
  assert.ok(Array.isArray(dec.notes) && dec.ratings.some((r) => r.run_id === RUN && r.rating === 'good'));
  assert.equal((await mac('decisions', { method: 'POST', body: '{}' })).status, 404); // the Mac token cannot decide or rate
  assert.equal((await mac('rate', { method: 'POST', body: '{}' })).status, 404);
  const counts = JSON.parse((await tool('get_status')).content[0].text);

  // Memory: a note proposed in a receipt waits in the panel; only a click (one-time code) decides it.
  const NOTE_RUN = 'r-20261012T123000Z-0c0c0c';
  const noted = { ...running, run_id: NOTE_RUN, status: 'completed', ended: '2026-10-12T12:31:00.000Z', memory_proposed: 2,
    memory_proposals: [{ scope: 'shared', body: 'Use git fetch dok to read review branches.' }, { scope: 'shared', body: 'token sk-abcdefghijklmnopqrstuvwxyz0123' }, { scope: 'bad scope', body: 'x' }] };
  assert.equal((await post(noted)).status, 200); assert.equal((await post(noted)).status, 200); // re-posting adds nothing
  const p2 = await tool('panel_data'), pv = JSON.parse(p2.content[0].text), review = p2._meta['agents-hub/confirm'].review;
  assert.equal(pv.pending.length, 1); assert.equal(pv.pending[0].kind, 'memory'); assert.match(pv.pending[0].body, /git fetch dok/);
  assert.equal(pv.status.pending.memory, 1);
  const noteId = pv.pending[0].id; assert.ok(review[noteId]); assert.doesNotMatch(p2.content[0].text, new RegExp(review[noteId]));
  await t.test('Mac panel matches Hub data without issuing or returning decision codes', async () => {
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM confirmations').first()).n;
    const response = await mac('panel');
    assert.equal(response.status, 200);
    const text = await response.text(), macPanel = JSON.parse(text);
    for (const field of ['agents', 'runs', 'pending', 'status']) assert.deepEqual(macPanel[field], pv[field]);
    assert.equal(macPanel.source, 'hub');
    assert.equal(macPanel.capabilities.run, false); assert.equal(macPanel.capabilities.mutate, false);
    assert.equal('confirm' in macPanel, false); assert.equal('_meta' in macPanel, false);
    for (const code of [...Object.values(review), ...Object.values(p2._meta['agents-hub/confirm'].rate)]) assert.ok(!text.includes(code));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM confirmations').first()).n, before);
    assert.equal((await mac('panel', {}, 'wrong')).status, 401);
    assert.equal((await mac('panel', {}, DOK)).status, 401);
    assert.equal((await mac('panel', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await (await mac(`runs/${RUN}`)).json()).run_id, RUN);
    assert.equal((await mac(`runs/${RUN}`, {}, DOK)).status, 401);
    assert.equal((await mac('runs/missing')).status, 404);
  });
  const decide = (args) => tool('review_decide', { id: noteId, decision: 'accept', request_id: 'review-request-1', ...args });
  await t.test('Mac running rows expire to unknown, recover on heartbeat, and keep their final receipt', async () => {
    const id = 'r-20261013T000000Z-aabbcc';
    const live = { run_id: id, agent: 'helper', status: 'running', task: 'Mac liveness', started: new Date().toISOString() };
    const postMac = receipt => mac('runs', { method: 'POST', body: JSON.stringify(receipt) });
    const viewMac = async () => (await (await mac('panel')).json());
    assert.equal((await postMac(live)).status, 200);
    assert.equal((await viewMac()).status.running, 1);
    assert.equal((await (await mac(`runs/${id}`)).json()).status, 'running');
    await db.prepare('UPDATE runs SET updated_at = ? WHERE run_id = ?').bind('2000-01-01T00:00:00Z', id).run();
    const stale = await viewMac();
    assert.equal(stale.runs.find(r => r.run_id === id).status, 'unknown'); assert.equal(stale.status.running, 0);
    const detail = await (await mac(`runs/${id}`)).json();
    assert.equal(detail.status, 'unknown'); assert.match(detail.error, /heartbeat expired/);
    assert.equal((await db.prepare('SELECT status FROM runs WHERE run_id = ?').bind(id).first()).status, 'running');
    const hosted = await tool('panel_data');
    assert.equal(hosted._meta['agents-hub/confirm'].rate[id], undefined, 'unknown does not authorize rating');
    assert.equal((await postMac(live)).status, 200);
    assert.equal((await viewMac()).status.running, 1, 'contact restores liveness');
    assert.equal((await postMac({ ...live, status: 'completed', ended: new Date().toISOString(), output: 'done' })).status, 200);
    await postMac(live);
    assert.equal((await (await mac(`runs/${id}`)).json()).status, 'completed', 'late heartbeat cannot reopen a finished run');
    assert.equal((await viewMac()).status.running, 0);
  });
  assert.match((await decide({ confirm: 'z'.repeat(24) })).content[0].text, /needs a click/);
  assert.match((await decide({ confirm: review[noteId] })).content[0].text, /accepted/);
  assert.match((await decide({ confirm: review[noteId] })).content[0].text, /needs a click/);
  assert.equal(JSON.parse((await tool('panel_data')).content[0].text).pending.length, 0);
  assert.equal(JSON.parse((await tool('get_status')).content[0].text).pending.memory, 0);

  // Definitions, skills and evals are published from git by the Mac; runners read bundles; list_agents follows the published set.
  const REV = 'a'.repeat(40), REV2 = 'b'.repeat(40);
  const push = (body, token = 'mac-secret-token') => mac('knowledge', { method: 'POST', body: JSON.stringify(body) }, token);
  const files = { 'agents/helper.md': '---\nname: helper\ndescription: Answers questions.\nmodel: openai/gpt-6-luna\ntools: read, grep\nskills: demo\nmemory_scopes: shared, agent:helper\n---\nBe brief.\n',
    'agent-skills/demo/SKILL.md': '# Demo skill\n', 'evals/helper/e-1.md': 'question' };
  assert.equal((await push({ revision: REV, base: null, files }, 'wrong')).status, 401);
  for (const bad of [{ 'agents/../x.md': 'x' }, { 'memory/shared/m.md': 'x' }, { 'agents/helper.md': 'token sk-abcdefghijklmnopqrstuvwxyz0123' }]) assert.equal((await push({ revision: REV, base: null, files: bad })).status, 400);
  const pushed = await (await push({ revision: REV, base: null, files })).json();
  assert.deepEqual([pushed.ok, pushed.files, pushed.removed], [true, 3, 0]);
  assert.equal((await (await mac('knowledge')).json()).revision, REV);
  const refused = await push({ revision: REV2, base: 'c'.repeat(40), files }); // not built on what the Hub holds
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /The Hub holds/);
  assert.equal((await push({ revision: REV2, base: REV, files: { 'agents/helper.md': files['agents/helper.md'] } })).status, 200); // drops the skill and eval
  assert.deepEqual(Object.keys((await (await dokGet('knowledge')).json()).files), ['agents/helper.md']);
  await push({ revision: REV, base: REV2, files });
  const kb = await (await dokGet('knowledge?agent=helper')).json();
  assert.deepEqual(Object.keys(kb.files).sort(), ['agent-skills/demo/SKILL.md', 'agents/helper.md']); assert.equal(kb.revision, REV);
  assert.deepEqual(kb.memory.map((m) => m.body), ['Use git fetch dok to read review branches.']); assert.match(kb.hash, /^[a-f0-9]{16}$/);
  assert.equal((await dokGet('knowledge?agent=nope')).status, 404);
  assert.equal((await dokGet('knowledge', 'wrong')).status, 401);
  const listed2 = JSON.parse((await tool('list_agents')).content[0].text);
  assert.deepEqual(listed2.agents.map((a) => [a.name, a.tools]), [['helper', ['read', 'grep']]]);
  assert.equal(listed2.agents[0].last_run.run_id !== undefined, true);
  // The runner's bundle: accepted notes for its scopes plus a content hash; the runner token only.
  const getBundle = (scopes, token = DOK) => mf.dispatchFetch('https://test/relay/dok-dev/bundle?scopes=' + scopes, { headers: { authorization: 'Bearer ' + token } });
  const b = await (await getBundle('shared,agent:helper')).json();
  assert.deepEqual(b.memory.map((m) => m.body), ['Use git fetch dok to read review branches.']); assert.match(b.hash, /^[a-f0-9]{16}$/);
  assert.equal((await (await getBundle('agent:helper')).json()).memory.length, 0);
  assert.equal((await getBundle('shared', 'wrong')).status, 401);
  assert.ok(counts.runs >= 1 && counts.last_run.run_id); // counts come from the Hub even with no snapshot

  const override = tool('start_run', { agent: 'helper', task: 'Deeper look', request_id: 'request-0004', model: 'openai/gpt-6.1-sol', thinking: 'high' });
  let o = await next(); while (o.type !== 'request') o = await next();
  assert.deepEqual(o.args, { request_id: 'request-0004', agent: 'helper', task: 'Deeper look', model: 'openai/gpt-6.1-sol', thinking: 'high' });
  ws.send(encode({ v: 1, session: 'dok-session-1', socket: hello.socket, type: 'result', attempt: o.attempt, id: o.id,
    result: { ok: true, value: { ...running, run_id: 'r-20261012T120500Z-abcdef', model: 'openai/gpt-6.1-sol', thinking: 'high' } } }));
  const ov = JSON.parse((await override).content[0].text);
  assert.equal(ov.model, 'openai/gpt-6.1-sol'); assert.equal(ov.thinking, 'high');
  assert.equal((await tool('start_run', { agent: 'helper', task: 'x', request_id: 'request-0005', thinking: 'extreme' })).isError, true);
  assert.equal((await tool('start_run', { agent: 'helper', task: 'x', request_id: 'request-0006', model: 'no-slash' })).isError, true);
  assert.match((await tool('start_run', { agent: 'network', task: 'x', request_id: 'request-0002' })).content[0].text, /dok does not run network; it offers: workflow, helper/);
  const WRUN = 'r-20261012T121000Z-0a0b0c', PREV = 'r-20261012T120900Z-aaaaaa';
  const write = tool('start_run', { agent: 'workflow', task: 'Add a comment', request_id: 'request-0003', repo: 'dev-workflow', continue_from: PREV });
  let w = await next(); while (w.type !== 'request') w = await next();
  assert.deepEqual(w.args, { request_id: 'request-0003', agent: 'workflow', task: 'Add a comment', repo: 'dev-workflow', continue_from: PREV });
  const wrun = { run_id: WRUN, agent: 'workflow', kind: 'task', runner: 'dok', status: 'running', task: 'Add a comment', started: '2026-10-12T12:10:00.000Z', repo: 'dev-workflow' };
  ws.send(encode({ v: 1, session: 'dok-session-1', socket: hello.socket, type: 'result', attempt: w.attempt, id: w.id, result: { ok: true, value: wrun } }));
  assert.equal(JSON.parse((await write).content[0].text).repo, 'dev-workflow');
  const sha = 'a'.repeat(40);
  assert.equal((await post({ ...wrun, status: 'completed', ended: '2026-10-12T12:12:00.000Z', commit: sha, base_commit: 'b'.repeat(40),
    review_ref: `refs/heads/review/runs/${WRUN}`, continued_from: PREV, changed_files: ['a.mjs', 'x\ny', 7] })).status, 200);
  const wdone = JSON.parse((await tool('get_run', { run_id: WRUN })).content[0].text);
  assert.equal(wdone.review_ref, `refs/heads/review/runs/${WRUN}`); assert.deepEqual(wdone.changed_files, ['a.mjs']); assert.equal(wdone.repo, 'dev-workflow'); assert.equal(wdone.continued_from, PREV);
  assert.equal((await post({ ...wrun, run_id: 'r-20261012T121100Z-0a0b0d', status: 'completed', review_ref: 'refs/heads/main' })).status, 200);
  assert.equal(JSON.parse((await tool('get_run', { run_id: 'r-20261012T121100Z-0a0b0d' })).content[0].text).review_ref, undefined); // only a run's own review ref is kept
  assert.equal((await tool('start_run', { agent: 'workflow', task: 'x', request_id: 'request-0007', repo: 'Bad Repo' })).isError, true);
  assert.equal((await post({ run_id: 'bad' })).status, 400);
  const accounts = (body, method = 'POST', token = DOK) => mf.dispatchFetch('https://test/relay/dok-dev/accounts', { method, headers: { authorization: 'Bearer ' + token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await accounts({ slot: 'openai', state: 'cooldown', until: '2999-01-01T00:00:00.000Z', last_error_kind: 'usage limit reached' }, 'POST', 'wrong')).status, 401);
  assert.equal((await accounts({ slot: 'openai', state: 'cooldown', until: '2999-01-01T00:00:00.000Z', last_error_kind: 'usage limit reached' })).status, 200);
  assert.equal((await accounts({ slot: 'openai-2', state: 'disabled', until: '2000-01-01T00:00:00.000Z', last_error_kind: 'account not eligible' })).status, 200);
  assert.equal((await accounts({ slot: 'evil', state: 'ok' })).status, 400);
  const pool = (await (await accounts(null, 'GET')).json()).accounts;
  assert.deepEqual(pool.map((a) => [a.slot, a.state]), [['openai', 'cooldown'], ['openai-2', 'ok']]); // elapsed disable reads as ok
  assert.equal(JSON.parse((await tool('get_status')).content[0].text).accounts.length, 2);
  const failedId = 'r-20261012T122000Z-abcdef';
  await post({ ...running, run_id: failedId, status: 'failed', error: 'model turn failed', output: 'Partial answer', output_partial: true,
    failure_context: { phase: 'model', last_tool: 'read', provider: 'openai', model: 'gpt-6-luna', message: '503 service unavailable' } });
  const failed = JSON.parse((await tool('panel_run', { run_id: failedId })).content[0].text);
  const macFailure = await (await mf.dispatchFetch(`https://test/relay/mac/runs/${failedId}`, { headers: { authorization: 'Bearer mac-secret-token' } })).json();
  assert.deepEqual(macFailure.failure_context, failed.failure_context);
  assert.equal(failed.failure_guidance.category, 'agent_model');
  assert.match(failed.failure_guidance.next_step, /provider diagnostic/);
  assert.deepEqual(macFailure.failure_guidance, failed.failure_guidance);
  assert.deepEqual(JSON.parse((await tool('get_run', { run_id: failedId })).content[0].text).failure_guidance, failed.failure_guidance);
  const storedFailure = JSON.parse((await db.prepare('SELECT receipt FROM runs WHERE run_id = ?').bind(failedId).first()).receipt);
  assert.equal(storedFailure.failure_guidance, undefined, 'read-time advice does not rewrite historical receipts');
  assert.equal(failed.failure_context.last_tool, 'read'); assert.equal(failed.output_partial, true); assert.equal(failed.output, 'Partial answer');
  ws.close();
});
