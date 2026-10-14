// Serialized authenticated MCP connection + the actual dashboard boot/refresh scripts; all state is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { generateKeyPair, SignJWT } from 'jose';
import { hubFetch } from '../src/worker-core.mjs';
import { dashboardHtml } from '../../agent-workflow/ui/dashboard.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
async function host(t, { relay = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-connection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state'), journal = path.join(root, 'journal');
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true }); fs.mkdirSync(path.join(journal, 'runs'), { recursive: true });
  const completed = (id, age, origin = true) => {
    const ended = new Date(Date.now() - age).toISOString(), request_id = 'request-' + id;
    fs.writeFileSync(path.join(state, 'runs', id + '.json'), JSON.stringify({ run_id: id, status: 'completed', ended }));
    if (origin) {
      fs.writeFileSync(path.join(journal, 'runs', id + '.json'), JSON.stringify({ request_id }));
      fs.writeFileSync(path.join(journal, request_id + '.json'), JSON.stringify({ state: 'done', value: { run_id: id } }));
    }
    return ended;
  };
  const calls = [], reads = [], dispatches = [];
  const f = { calls, reads, dispatches, completed, online: true, enabled: true, failPanel: false, changeHealth: h => h };
  const keys = await generateKeyPair('RS256');
  const stamp = new Date().toISOString();
  // An empty Hub: every D1 read answers with nothing.
  const statement = { bind: () => statement, all: async () => ({ results: [] }), first: async () => null };
  const env = { ACCESS_ISSUER: 'https://fixture.invalid', ACCESS_AUD: 'fixture-hub',
    DB: { prepare(sql) { assert.match(sql, /^SELECT /); reads.push(sql); return statement; } } };
  if (relay) {
    // The runner (dok) is the only Durable Object the Hub talks to now.
    env.DOK_RELAY_TOKEN = 'fixture-only'; env.DEVELOPMENT_ENABLED = 'true';
    env.RELAY = { getByName() { return {
      status() { const at = new Date().toISOString(); return { online: f.online, enabled: f.enabled, agents: ['helper'], observed_at: at, last_seen_at: at, protocol_version: 1 }; },
      dispatch(name) { assert.fail('connection/refresh must not start a model or make a decision: ' + name); },
    }; } };
  }
  Object.defineProperty(env, 'PUBLISH_TOKEN', { get() { assert.fail('connection/refresh must not access publisher'); } });
  const token = await new SignJWT({ sub: 'fixture-owner' }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.ACCESS_ISSUER).setAudience(env.ACCESS_AUD).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  let id = 0;
  const send = async (method, params = {}, { notification = false, authorized = true } = {}) => {
    calls.push(method === 'tools/call' ? params.name : method);
    return hubFetch(new Request('https://fixture.invalid/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(authorized ? { 'cf-access-jwt-assertion': token } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++id } : {}), method, params }) }), env, dashboardHtml({ bridge: '' }), keys.publicKey);
  };
  const rpc = async (method, params) => {
    const response = await send(method, params); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.error, undefined); return body.result;
  };
  f.callTool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  f.connect = async () => {
    for (const method of ['initialize', 'tools/list', 'resources/list', 'resources/read']) {
      assert.equal((await send(method, {}, { authorized: false })).status, 401);
    }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-host', version: '1' } });
    assert.equal(init.protocolVersion, '2025-06-18'); assert.ok(init.capabilities.tools); assert.ok(init.capabilities.resources);
    const initialized = await send('notifications/initialized', {}, { notification: true });
    assert.equal(initialized.status, 202); assert.equal(await initialized.text(), '');
    assert.deepEqual(await rpc('ping'), {});
    const tools = (await rpc('tools/list')).tools;
    const open = tools.find(x => x.name === 'open_dashboard'); assert.ok(tools.some(x => x.name === 'get_status'));
    assert.equal(tools.some(x => x.name === 'panel_data'), relay);
    const resources = (await rpc('resources/list')).resources;
    assert.equal(resources[0].uri, open._meta.ui.resourceUri);
    const resource = (await rpc('resources/read', { uri: open._meta.ui.resourceUri })).contents[0];
    assert.match(resource.mimeType, /mcp-app/); assert.match(resource.text, /<title>Agents Hub<\/title>/);
    const legacy = (await rpc('resources/read', { uri: 'ui://agents/dashboard.html' })).contents[0];
    assert.equal(legacy.uri, 'ui://agents/dashboard.html'); assert.equal(legacy.text, resource.text);
    assert.equal(reads.length, 0, 'connection/discovery/resources do not read D1');
    return resource.text;
  };
  return { ...f, send, rpc, env, keys, token, state, journal, controls: f };
}

for (const relay of [false, true]) test(`an empty Hub supports authenticated connection, discovery and resources (relay=${relay})`, async t => {
  const f = await host(t, { relay }); await f.connect();
  const status = JSON.parse((await f.callTool('get_status')).content[0].text);
  const opened = (await f.callTool('open_dashboard')).structuredContent;
  assert.equal(status.agents, null); assert.equal(opened.status.running, null);
  assert.equal(opened.health.snapshot.state, 'unavailable'); assert.equal(opened.capabilities.run, false);
  assert.equal(opened.health.relay.state, relay ? 'connected' : 'unknown');
  assert.deepEqual(JSON.parse((await f.callTool('list_runs')).content[0].text).runs, []);
  assert.deepEqual(JSON.parse((await f.callTool('list_agents')).content[0].text).agents, []);
  const missing = await f.callTool('get_run', { run_id: 'r-20261014T000000Z-abcdef' });
  assert.equal(missing.isError, true); assert.match(missing.content[0].text, /no run/);
  // The retired snapshot routes are gone.
  const rest = await hubFetch(new Request('https://fixture.invalid/mcp/v1/agents', { headers: { 'cf-access-jwt-assertion': f.token } }), f.env, '', f.keys.publicKey);
  assert.equal(rest.status, 404); assert.deepEqual(f.dispatches, []);
});

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  contains() { return false; }
}
const text = el => el.children.map(c => c instanceof Element ? text(c) : c).join(' ');
async function mount(t, f, { initial = false } = {}) {
  const html = await f.connect(), first = initial ? await f.callTool('open_dashboard') : null;
  const elements = new Map(), timers = new Map(); let timer = 0, connects = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); };
  const context = vm.createContext({ Node: Element, console, setTimeout: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; },
    clearTimeout: id => timers.delete(id), matchMedia: () => ({ matches: false }),
    document: { documentElement: { dataset: {}, style: { setProperty() {} } }, activeElement: null,
      getElementById: get, createElement: tag => new Element(tag), querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    ExtApps: { App: class {
      async connect() { connects++; if (first) this.ontoolresult(first); }
      getHostContext() { return {}; }
      callServerTool({ name, arguments: args }) { return f.callTool(name, args); }
    } },
  });
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  vm.runInContext(scripts[1], context);
  await vm.runInContext(`(async()=>{${scripts[2]}\nglobalThis.fixture={app,state:S};})()`, context);
  const settle = async () => {
    const start = Date.now();
    while (context.fixture.state.refreshing) { assert.ok(Date.now() - start < 5000, 'dashboard refresh must finish'); await new Promise(setImmediate); }
  };
  if (!initial) {
    const fallback = [...timers.values()].find(x => x.ms === 1500); assert.ok(fallback); fallback.fn();
  }
  await settle(); assert.equal(connects, 1);
  t.after(() => context.fixture.app.onteardown());
  return { state: context.fixture.state, get, deliver: async result => { context.fixture.app.ontoolresult(result); await settle(); }, refresh: async () => { await get('refresh').onclick(); await settle(); } };
}

test('session request tool result opens Development without launching a task', async t => {
  const f = await host(t), call = f.callTool;
  f.callTool = async (name, args) => {
    if (name === 'development_panel') return { structuredContent: { grants: [], host: { online: true } } };
    const result = await call(name,args);
    if (name === 'open_dashboard') result.structuredContent.development_available = true;
    // Hosted polls read panel_data alone; it reports the same Development availability.
    if (name === 'panel_data' && !result.isError) {
      const v = JSON.parse(result.content[0].text);
      if (!v.unchanged) { v.development_available = true; delete v.development; result.content[0].text = JSON.stringify(v); }
    }
    return result;
  };
  const ui = await mount(t,f);
  await ui.deliver({structuredContent:{view:'development',grant_id:'pending-grant',manifest:{host:'dok-dev'}}});
  assert.equal(ui.state.tab,'development');
  assert.match(text(ui.get('view')),/New development session/);
  assert.ok(!f.calls.includes('start_development_task'));
});
