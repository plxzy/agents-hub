import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { WIRE, encode, PING, PONG } from '../../agent-workflow/relay-wire.mjs';
const token = 'test-only-machine-token';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('WebSocket relay in real Workers runtime', async (t) => {
  const bundle = await build({ entryPoints: [new URL('./fixtures/relay-runtime.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'], platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "relay-test", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01',
    durableObjects: { RELAY: { className: 'TestRelay', useSQLite: true } }, bindings: { RELAY_TOKEN: token, DOK_RELAY_TOKEN: 'dok-test-only', DEVELOPMENT_ENABLED: 'true' } }] }));
  t.after(() => mf.dispose());
  const api = async (route, body) => (await mf.dispatchFetch('https://test/' + route, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
  const connect = async (session, mode = 'acquire', options = {}) => {
    const res = await mf.dispatchFetch('https://test/relay/' + (options.dok ? 'dok-dev/' : '') + 'connect', { headers: { upgrade: 'websocket', authorization: 'Bearer ' + (options.token ?? token),
      'x-relay-hello': encode({ v: options.version ?? 1, session, mode, status: { enabled: true, agents: ['helper'] } }) } });
    if (res.status !== 101) { if (![400,401,409].includes(res.status)) console.error('connect failed', res.status, await res.clone().text()); return res; }
    const ws = res.webSocket; const messages = []; const waiting = [];
    ws.accept(); ws.addEventListener('message', ({ data }) => { const m = data === PONG ? data : JSON.parse(data); if (waiting.length) waiting.shift()(m); else messages.push(m); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((r, reject) => {
      const timer = setTimeout(() => reject(new Error('No socket message')), 5000); waiting.push((m) => { clearTimeout(timer); r(m); });
    });
    const hello = await next();
    return { ws, hello, next, send: (m) => ws.send(encode({ v: 1, session, socket: hello.socket, ...m })) };
  };
  let client;
  await t.test('dok has separate credentials, durable owner grants and offline revocation', async () => {
    assert.equal((await connect('dok-process-one', 'acquire', { dok: true })).status, 401);
    const dok = await connect('dok-process-one', 'acquire', { dok: true, token: 'dok-test-only' });
    const dev = (operation, args = {}, owner = 'owner-one') => api('dev/call', { owner, operation, args });
    const pending = dev('request_development', { request_id: 'dev-request-one' });
    const m = await dok.next(); assert.equal(m.operation, 'dev_prepare');
    const manifest = { host: 'dok-dev', project: 'dev-workflow', agent: 'workflow', conversation_id: 'conversation-0001', workspace_id: 'workspace-0001',
      implementation_revision: 'revision-0001', knowledge_revision: 'knowledge-0001', policy_digest: 'policy-00001', process_session: 'dok-process-one' };
    dok.send({ type: 'result', attempt: m.attempt, id: m.id, result: { ok: true, value: manifest } }); await dok.next();
    const grant = (await pending).value;
    const panel = (await dev('development_panel')).value;
    const confirm = panel.confirm[grant.grant_id].token;
    assert.deepEqual((await dev('get_development', {}, 'other')).value.grants, []);
    assert.ok((await dev('decide_development', { grant_id: grant.grant_id, decision: 'approve', confirm }, 'other')).error);
    assert.equal((await dev('decide_development', { grant_id: grant.grant_id, decision: 'approve', confirm })).value.status, 'active');
    const lease = async (execution_state = 'running', machineToken = 'dok-test-only') => {
      const r = await mf.dispatchFetch('https://test/relay/dok-dev/lease', { method: 'POST', headers: { authorization: 'Bearer ' + machineToken },
        body: JSON.stringify({ grant_id: grant.grant_id, policy_digest: manifest.policy_digest, process_session: manifest.process_session, execution_state }) });
      return { status: r.status, value: await r.json() };
    };
    assert.equal((await lease('running', token)).status, 401);
    assert.equal((await lease()).value.authorized, true);
    const revoke = (await dev('development_panel')).value.confirm[grant.grant_id].token;
    dok.ws.close();
    const revoked = (await dev('decide_development', { grant_id: grant.grant_id, decision: 'revoke', confirm: revoke })).value;
    assert.equal(revoked.execution_confirmed_stopped, false);
    await mf.unsafeEvictDurableObject('relay-test', 'TestRelay', { name: 'owner-dok-dev', webSockets: 'hibernate' });
    assert.equal((await lease()).value.authorized, false);
    assert.equal((await lease('stopped')).value.stopped, true);
    const after = (await dev('get_development')).value.grants[0];
    assert.equal(after.status, 'revoked'); assert.equal(after.execution_confirmed_stopped, true);
  });
  await t.test('authentication, protocol and ownership validation precede eviction', async () => {
    assert.equal((await connect('process-one', 'acquire', { token: 'publisher-token' })).status, 401);
    assert.match((await api('call', { operation: 'panel_data', args: {} })).error, /offline/);
    client = await connect('process-one');
    assert.equal((await connect('process-bad', 'acquire', { version: 2 })).status, 400);
    assert.equal((await connect('unknown-process', 'resume')).status, 409);
    assert.equal((await api('status')).online, true);
    assert.equal((await mf.dispatchFetch('https://test/relay/poll', { headers: { authorization: 'Bearer ' + token } })).status, 404);
  });
  assert.ok(client?.ws, "initial socket must connect");
  await t.test('one-shot status adds timestamps/version without dispatch or journal mutations', async () => {
    const before = await api('inspect');
    const status = await api('status');
    assert.equal(status.online, true); assert.equal(status.enabled, true);
    assert.deepEqual(status.agents, ['helper']); assert.equal(status.protocol_version, WIRE.version);
    assert.ok(Number.isFinite(Date.parse(status.observed_at))); assert.ok(Number.isFinite(Date.parse(status.last_seen_at)));
    assert.deepEqual(await api('inspect'), before);
  });
  let job;
  const args = { agent: 'helper', task: 'read', request_id: 'runtime-request' };
  await t.test('dispatch durable before send; concurrent duplicates share one operation', async () => {
    const first = api('call', { operation: 'start_run', args });
    job = await client.next();
    const before = await api('inspect'); assert.equal(before.attempts.length, 1); assert.equal(before.requests[0].result, null);
    const duplicate = api('call', { operation: 'start_run', args: { task: 'read', request_id: args.request_id, agent: 'helper' } });
    await pause(40); assert.equal((await api('inspect')).attempts.length, 1);
    client.send({ type: 'result', attempt: job.attempt, id: job.id, result: { ok: true, value: { run_id: 'r-test' } } });
    assert.equal((await client.next()).type, 'ack');
    assert.ok((await api('inspect')).requests[0].result);
    assert.deepEqual(await first, { value: { run_id: 'r-test' } }); assert.deepEqual(await duplicate, await first);
    assert.deepEqual(await api('call', { operation: 'start_run', args }), await first);
    assert.match((await api('call', { operation: 'start_run', args: { ...args, task: 'different' } })).error, /different action/);
  });
  await t.test('late completion survives waiter timeout and explicit retry has fresh expiry', async () => {
    const a = { ...args, request_id: 'late-request' };
    const first = api('call', { operation: 'start_run', args: a }); const old = await client.next();
    const anchor = (await api('inspect')).requests.find((r) => r.id === a.request_id).until;
    await api('timeout?id=' + a.request_id); assert.ok((await first).error);
    await pause(10);
    const second = api('call', { operation: 'start_run', args: a }); const retry = await client.next();
    assert.notEqual(retry.attempt, old.attempt); assert.ok(retry.expires > old.expires);
    assert.equal((await api('inspect')).requests.find((r) => r.id === a.request_id).until, anchor);
    await api('timeout?id=' + a.request_id); await second;
    client.send({ type: 'result', attempt: old.attempt, id: old.id, result: { ok: true, value: { run_id: 'r-late' } } });
    await client.next(); assert.deepEqual(await api('call', { operation: 'start_run', args: a }), { value: { run_id: 'r-late' } });
  });
  await t.test('replacement fences old session even when it never processes the close notification', async () => {
    const old = client; client = await connect('process-two');
    assert.equal((await connect('process-one', 'resume')).status, 409);
    assert.equal((await api('status')).online, true);
    old.ws.close();
  });
  await t.test('keepalive auto-response refreshes status without a D1 heartbeat', async () => {
    await api('stale'); assert.equal((await api('status')).online, false);
    client.ws.send(PING); assert.equal(await client.next(), PONG);
    assert.equal((await api('status')).online, true);
  });
  await t.test('hibernation restores socket attachments and auto-response without a new connection', async () => {
    const before = await api('inspect');
    await mf.unsafeEvictDurableObject('relay-test', 'TestRelay', { name: 'owner-mac', webSockets: 'hibernate' });
    client.ws.send(PING); assert.equal(await client.next(), PONG);
    const after = await api('inspect'); assert.notEqual(after.boot, before.boot);
    assert.equal((await api('status')).online, true);
    assert.deepEqual(await api('call', { operation: 'start_run', args }), { value: { run_id: 'r-test' } });
  });
  await t.test('runtime reset retains ownership and completed receipts', async () => {
    await api('reset'); client = await connect('process-two', 'resume');
    assert.deepEqual(await api('call', { operation: 'start_run', args }), { value: { run_id: 'r-test' } });
  });
  await t.test('interrupted local claims do not become terminal cached results', async () => {
    const a = { ...args, request_id: 'interrupted-request' };
    const first = api('call', { operation: 'start_run', args: a }); const m = await client.next();
    client.send({ type: 'result', attempt: m.attempt, id: m.id, result: { ok: false, kind: 'interrupted', error: 'inspect local journal' } }); await client.next();
    assert.match((await first).error, /journal/);
    assert.equal((await api('inspect')).requests.find((r) => r.id === a.request_id).result, null);
  });
  await t.test('capacity is bounded; off switch refuses only starts', async () => {
    client.send({ type: 'status', status: { enabled: false, agents: ['helper'] } });
    await pause(10);
    assert.match((await api('call', { operation: 'start_run', args: { ...args, request_id: 'disabled-request' } })).error, /off/);
    const calls = [];
    for (let i = 0; i < WIRE.capacity; i++) {
      calls.push(api('call', { operation: 'panel_data', args: {} })); await client.next();
    }
    assert.match((await api('call', { operation: 'panel_data', args: {} })).error, /busy/);
    const rows = await api('inspect');
    for (const row of rows.requests) await api('timeout?id=' + row.id);
    await Promise.all(calls);
    client.send({ type: 'status', status: { enabled: true, agents: ['helper'] } });
    await pause(20); assert.equal((await api('status')).enabled, true);
  });
  await t.test('real deadline settles the waiter but retains a valid late receipt', async () => {
    const a = { ...args, request_id: 'actual-timeout-request' };
    const call = api('call', { operation: 'start_run', args: a }); const m = await client.next();
    assert.match((await call).error, /SAME request_id/);
    client.send({ type: 'result', attempt: m.attempt, id: m.id, result: { ok: true, value: { run_id: 'r-after-timeout' } } }); await client.next();
    assert.deepEqual(await api('call', { operation: 'start_run', args: a }), { value: { run_id: 'r-after-timeout' } });
  });
  await t.test('cleanup is idempotent, removes attempts and leaves no work', async () => {
    const state = await api('expire'); assert.equal(state.requests.length, 0); assert.equal(state.attempts.length, 0);
    client.ws.close();
  });
});

test('UTF-8 limits cover the entire serialized message', () => {
  assert.throws(() => encode({ v: 1, text: '😀'.repeat(70000) }), /large/);
  assert.ok(encode({ v: 1, text: 'a'.repeat(WIRE.messageBytes - 30) }));
});

test('hosted tool results keep confirmation codes exclusively in widget metadata', async () => {
  const { apiFetch } = await import('../src/worker-core.mjs');
  const env = { RELAY_TOKEN: token, RELAY: { getByName: () => ({ dispatch: async () => ({ ok: true, value: { agents: [], confirm: { review: { p: 'private-code' } } } }) }) },
    DB: { prepare: () => ({ first: async () => ({ id: 's', published_at: new Date().toISOString(), payload: JSON.stringify({ generated_at: new Date().toISOString(), agents: [], runs: [] }) }) }) } };
  const response = await apiFetch(new Request('https://test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'panel_data', arguments: {} } }) }), env);
  const body = await response.json(); assert.equal(body.result._meta['agents-hub/confirm'].review.p, 'private-code');
  assert.doesNotMatch(body.result.content[0].text, /private-code/);
});

test('production Worker absorbs delayed cron delivery without a D1 binding', async (t) => {
  const bundle = await build({ entryPoints: [new URL('../src/worker.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
    plugins: [{ name: 'test-dashboard', setup(b) {
      b.onResolve({ filter: /^virtual:agents-hub-dashboard$/ }, () => ({ path: 'dashboard', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default "test dashboard";', loader: 'js' }));
    } }] });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01' }));
  t.after(() => mf.dispose());
  const worker = await mf.getWorker();
  const response = await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal(response.outcome, 'ok');
});
