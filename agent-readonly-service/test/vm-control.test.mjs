import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, PONG } from '../../agent-workflow/relay-wire.mjs';
import { validateDevelopment } from '../../agent-workflow/dev-contract.mjs';
import { createVmControlHost } from '../../agent-workflow/vm-control-host.mjs';
import { vmControlPrincipal } from '../src/vm-control.mjs';

// The Hub side of plxzy/vm#806: the Worker validates, asserts the principal, forwards over the authenticated runner relay,
// and returns what the supervisor answers. Everything else (grants, intent record, dedupe) is the runner's, tested there.
const bundle = await build({ entryPoints: [new URL('./fixtures/hub-runtime.mjs', import.meta.url).pathname], bundle: true, write: false,
  format: 'esm', external: ['cloudflare:workers'], platform: 'browser', loader: { '.html': 'text' } });
const intent = { format: 1, operation: 'stop', target: 'browser', hostId: 'fixture-host', service: 'fixture-service', projectId: 'fixture-project',
  worker: 'container', workerGeneration: 'fixture-generation', backingId: '0123456789abcdef' };
const KEY = 'request-key-0001';

async function hub(t, bindings) {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'vm-control-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], durableObjects: { RELAY: { className: 'AgentRelay', useSQLite: true } },
    bindings: { DOK_RELAY_TOKEN: 'dok-test', DEVELOPMENT_ENABLED: 'true', ...bindings } }] }));
  t.after(() => mf.dispose());
  const rpc = async (method, params = {}, owner = 'owner') => (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST', headers: { 'x-test-owner': owner }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  return { mf, rpc, tool: (name, args = {}, owner) => rpc('tools/call', { name, arguments: args }, owner), tools: async () => (await rpc('tools/list')).tools.map(x => x.name) };
}
async function runner(mf, session = 'vm-control-session') {
  const res = await mf.dispatchFetch('https://test/relay/dok-dev/connect', { headers: { upgrade: 'websocket', authorization: 'Bearer dok-test',
    'x-relay-hello': encode({ v: 1, session, mode: 'acquire', status: { enabled: true, agents: ['workflow'] } }) } });
  const ws = res.webSocket, inbox = [], waiting = [];
  ws.accept(); ws.addEventListener('message', ({ data }) => { if (data === PONG) return; const m = JSON.parse(data); if (waiting.length) waiting.shift()(m); else inbox.push(m); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('No relay message')), 3000); waiting.push(m => { clearTimeout(timer); resolve(m); });
  });
  const hello = await next();
  return { ws, inbox, next, answer: (m, result) => ws.send(encode({ v: 1, session, socket: hello.socket, type: 'result', attempt: m.attempt, id: m.id, result })) };
}
const text = r => r.content[0].text;

test('VM control is neither listed nor callable until the Hub enables it', async t => {
  const { tool, tools } = await hub(t, {});
  assert.deepEqual((await tools()).filter(n => n.endsWith('vm_control')), []);
  for (const name of ['submit_vm_control', 'get_vm_control']) {
    const refused = await tool(name, name === 'get_vm_control' ? { mutation_id: 'vmc-' + 'a'.repeat(32) } : { request_key: KEY, intent });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /unavailable/);
  }
});

test('enabled: requests are validated before the relay, the principal is the Worker\u2019s, and the runner\u2019s answer is returned', async t => {
  const { mf, tool, tools } = await hub(t, { VM_CONTROL_ENABLED: 'true' });
  const listed = await tools();
  assert.ok(listed.includes('submit_vm_control') && listed.includes('get_vm_control'));
  const link = await runner(mf);

  // Invalid requests never reach the runner's ordered command queue.
  for (const args of [{ request_key: KEY, intent: { ...intent, backingId: undefined } }, { request_key: KEY, intent: { ...intent, target: 'backing', operation: 'restart' } },
    { request_key: KEY, intent: { ...intent, command: 'ls' } }, { request_key: 'short', intent }, { request_key: KEY, intent, principal: 'someone-else' }, { intent }]) {
    const r = await tool('submit_vm_control', args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal((await tool('get_vm_control', { mutation_id: 'nope' })).isError, true);
  assert.equal(link.inbox.length, 0);

  const pending = tool('submit_vm_control', { request_key: KEY, intent });
  const request = await link.next();
  assert.equal(request.operation, 'vm_control_submit');
  const principal = await vmControlPrincipal('owner');
  assert.match(principal, /^hub:[0-9a-f]{32}$/);
  assert.deepEqual(request.args, { principal, request_key: KEY, intent });
  const mutationId = 'vmc-' + 'b'.repeat(32);
  const value = { response: { format: 1, request: { ...intent, kind: 'control', mutationId }, state: 'confirmed', source: 'service-door', reply: { status: 200, result: {} }, error: null }, view: null };
  link.answer(request, { ok: true, value }); await link.next();
  assert.deepEqual(JSON.parse(text(await pending)), value);

  const read = tool('get_vm_control', { mutation_id: mutationId, refresh: true });
  const get = await link.next();
  assert.equal(get.operation, 'vm_control_get');
  assert.deepEqual(get.args, { principal, mutation_id: mutationId, refresh: true });
  link.answer(get, { ok: false, kind: 'rejected', error: 'bad-request: unknown intent' }); await link.next();
  const refused = await read;
  assert.equal(refused.isError, true);
  assert.match(text(refused), /unknown intent/);
  // Another verified user gets another principal, so the runner never maps two users onto one grant.
  const other = tool('submit_vm_control', { request_key: KEY, intent }, 'user-b');
  const otherRequest = await link.next();
  assert.match(otherRequest.args.principal, /^hub:[0-9a-f]{32}$/);
  assert.notEqual(otherRequest.args.principal, principal);
  assert.equal(otherRequest.args.principal, await vmControlPrincipal('user-b'));
  link.answer(otherRequest, { ok: false, kind: 'rejected', error: 'no grant' }); await link.next();
  assert.equal((await other).isError, true);
  link.ws.close();
});

test('a lost relay response tells the caller to repeat the same request key, not a relay id', async t => {
  const { mf, tool } = await hub(t, { VM_CONTROL_ENABLED: 'true' });
  const link = await runner(mf);
  const pending = tool('submit_vm_control', { request_key: KEY, intent });
  await link.next();
  link.ws.close(); // the runner's link drops after the request was delivered: the relay cannot know the outcome
  const lost = await pending;
  assert.equal(lost.isError, true);
  assert.match(text(lost), /SAME request_key/);
  assert.doesNotMatch(text(lost), /request_id/);
  // Offline runner: nothing was queued, and the answer says so.
  const offline = await tool('submit_vm_control', { request_key: 'request-key-0002', intent });
  assert.equal(offline.isError, true);
  assert.match(text(offline), /No action was queued/);
});

test('end to end: Worker, relay, supervisor host, real grants and the stdio door; a lost relay answer is recovered by the same key', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-control-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), fixture = path.join(home, 'fixture');
  fs.mkdirSync(path.join(fixture, 'flags'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/vmservice-node'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/vmservice-node/control.token'), 'synthetic-credential-0001\n', { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, 'daemon.json'), JSON.stringify({ serviceId: 'fixture-service', worker: 'container', generation: 'fixture-generation',
    backing: '0123456789abcdef', claims: {}, effects: {} }));
  const credentialFile = path.join(root, 'door.credential');
  fs.writeFileSync(credentialFile, 'synthetic-credential-0001\n', { mode: 0o600 });
  const helper = fileURLToPath(new URL('../../agent-workflow/fixtures/vm-control-fixture-helper.mjs', import.meta.url));
  const host = createVmControlHost({ owners: ['fixture-owner'], doors: { 'door-1': { helper, env: { HOME: home, PATH: process.env.PATH }, credentialFile } } }, { stateDir: path.join(root, 'vm-control') });
  host.enrollment.enroll('fixture-owner', 'fixture-project', { hostId: 'fixture-host', service: 'fixture-service', doorRef: 'door-1', workers: ['container'],
    targets: ['backing', 'browser'], operations: ['start', 'stop', 'restart'] });
  for (const mode of ['mutate', 'read']) {
    const pending = host.enrollment.request(await vmControlPrincipal('owner'), `req-${mode}`, { projectId: 'fixture-project', mode });
    host.enrollment.decide('fixture-owner', pending.grant_id, 'approve', host.enrollment.issue('fixture-owner', pending.grant_id, 'approve'));
  }
  const calls = () => (fs.existsSync(path.join(fixture, 'calls.jsonl')) ? fs.readFileSync(path.join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  const controls = () => calls().filter(c => c.op === 'control-worker').length;

  const { mf, tool } = await hub(t, { VM_CONTROL_ENABLED: 'true' });
  // What dev-supervisor.mjs does for these operations, over the same relay messages.
  const serve = link => (async () => {
    for (;;) {
      let m; try { m = await link.next(); } catch { return; }
      if (m.type !== 'request') continue;
      validateDevelopment(m.operation, m.args, true);
      const result = await host.execute(m.operation, m.args);
      if (!link.silent) link.answer(m, result);
    }
  })();
  let link = await runner(mf, 'e2e-session-1'); serve(link);
  const first = JSON.parse(text(await tool('submit_vm_control', { request_key: KEY, intent })));
  assert.equal(first.response.state, 'confirmed');
  assert.equal(first.view.label, 'Browser stop (not a backing stop)');
  assert.equal(controls(), 1);
  const id = first.response.request.mutationId;
  const recorded = JSON.parse(text(await tool('get_vm_control', { mutation_id: id })));
  assert.equal(recorded.response.state, 'confirmed');
  const refreshed = JSON.parse(text(await tool('get_vm_control', { mutation_id: id, refresh: true })));
  assert.equal(refreshed.response.state, 'confirmed');
  assert.equal(controls(), 1, 'reads never send');

  // The runner executes the second action, but its result never reaches the Worker.
  link.silent = true;
  const second = 'request-key-0002', other = { ...intent, operation: 'restart' };
  const lostCall = tool('submit_vm_control', { request_key: second, intent: other });
  for (let i = 0; i < 100 && controls() < 2; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(controls(), 2);
  link.ws.close(); // the link drops with the result unsent: the relay cannot know the outcome
  const lost = await lostCall;
  assert.equal(lost.isError, true);
  assert.match(text(lost), /SAME request_key/);
  link = await runner(mf, 'e2e-session-2'); serve(link);
  const replay = JSON.parse(text(await tool('submit_vm_control', { request_key: second, intent: other })));
  assert.equal(replay.response.state, 'confirmed');
  assert.equal(replay.response.request.operation, 'restart');
  assert.equal(controls(), 2, 'the repeated key read the original outcome and sent nothing');
  assert.equal(JSON.parse(text(await tool('submit_vm_control', { request_key: KEY, intent: other }))).response.error.code, 'request-key-conflict');
  assert.equal(controls(), 2);
  // Another verified user holds no grant: refused at admission, the helper is never launched, and the first user's intent is unreadable.
  const stranger = JSON.parse(text(await tool('submit_vm_control', { request_key: 'request-key-0003', intent }, 'user-b')));
  assert.equal(stranger.response.source, 'admission');
  assert.equal(stranger.response.request, null);
  assert.equal(controls(), 2);
  assert.equal((await tool('get_vm_control', { mutation_id: id }, 'user-b')).isError, true);
  link.ws.close();
});

test('the principal is stable per verified user, carries no subject text, and needs a verified user', async () => {
  const a = await vmControlPrincipal('user-a@example.test');
  assert.equal(a, await vmControlPrincipal('user-a@example.test'));
  assert.notEqual(a, await vmControlPrincipal('user-b@example.test'));
  assert.doesNotMatch(a, /user|example/);
  for (const none of [null, undefined, '', 7]) await assert.rejects(vmControlPrincipal(none), /authenticated user/);
});
