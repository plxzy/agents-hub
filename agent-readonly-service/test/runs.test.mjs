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
  for (const file of ['0001_snapshots.sql', '0003_runs.sql', '0004_accounts.sql', '0005_decisions.sql', '0006_memory.sql']) {
    for (const sql of fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const tool = async (name, args = {}) => (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const post = (body, token = DOK) => mf.dispatchFetch('https://test/relay/dok-dev/runs', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });

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
  const decide = (args) => tool('review_decide', { id: noteId, decision: 'accept', request_id: 'review-request-1', ...args });
  assert.match((await decide({ confirm: 'z'.repeat(24) })).content[0].text, /needs a click/);
  assert.match((await decide({ confirm: review[noteId] })).content[0].text, /accepted/);
  assert.match((await decide({ confirm: review[noteId] })).content[0].text, /needs a click/);
  assert.equal(JSON.parse((await tool('panel_data')).content[0].text).pending.length, 0);
  assert.equal(JSON.parse((await tool('get_status')).content[0].text).pending.memory, 0);
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
  ws.close();
});
