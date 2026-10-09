// A tiny DOM fixture executes the real dashboard script; no browser, network or live decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardHtml } from './dashboard.mjs';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  contains() { return false; }
}
const text = (el) => el.children.map(c => c instanceof Element ? text(c) : c).join(' ');

test('real dashboard preserves unknown reviews, snapshot authority and explicit remote allowlist controls', async () => {
  const elements = new Map(), calls = [];
  const get = (id) => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); };
  const context = vm.createContext({ Node: Element, console, setTimeout: () => 1, clearTimeout() {}, matchMedia: () => ({ matches: false }),
    document: { documentElement: { dataset: {}, style: { setProperty() {} } }, activeElement: null,
      getElementById: get, createElement: tag => new Element(tag), querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    ExtApps: { web: true, App: class { async connect() {} getHostContext() { return {}; } async callServerTool(args) { calls.push(args); throw new Error('not a live host'); } } },
  });
  const scripts = [...dashboardHtml({ bridge: '' }).matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  vm.runInContext(scripts[1], context);
  await vm.runInContext(`(async()=>{${scripts[2]}\nglobalThis.fixture={setData,canRun,allowedForRun};})()`, context);
  const base = { status: { agents: null, running: null, pending: {} }, agents: [], runs: [], pending: null,
    capabilities: { run: false, mutate: false }, snapshot: { generated_at: null, published_at: null },
    relay: { online: null, enabled: null } };
  context.fixture.setData(base);
  let chips = text(get('chips'));
  assert.match(chips, /review: unknown/); assert.match(chips, /Relay: unknown/);
  assert.match(chips, /Remote execution: unknown/); assert.match(chips, /age unknown/);
  assert.doesNotMatch(chips, /NaN|0 running|deliberately off/); assert.equal(context.fixture.canRun(), false);
  // A snapshot paired with an online relay must not make its run capability true.
  base.relay = { online: true, enabled: true }; context.fixture.setData(base);
  assert.equal(context.fixture.canRun(), false); assert.equal(base.capabilities.run, false);
  const live = { ...base, snapshot: undefined, capabilities: { run: true, mutate: true },
    agents: [{ name: 'helper', remote_allowed: true }, { name: 'network' }], pending: [] };
  context.fixture.setData(live); assert.equal(context.fixture.canRun(), true);
  assert.equal(context.fixture.allowedForRun(live.agents[0]), true); assert.equal(context.fixture.allowedForRun(live.agents[1]), false);
  live.relay = { online: true, enabled: false }; context.fixture.setData(live); assert.equal(context.fixture.canRun(), false);
  live.relay = { online: false, enabled: true }; context.fixture.setData(live); assert.equal(context.fixture.canRun(), false);
  assert.deepEqual(calls, [], 'rendering/health labels must not call run, decisions, or even a host tool');
});
