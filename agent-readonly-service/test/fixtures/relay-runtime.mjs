// Test-only entrypoint. Never imported by the production Worker.
import { AgentRelay } from '../../src/agent-relay.mjs';
import { relayFetch } from '../../src/relay.mjs';
import { validateRelay } from '../../../agent-workflow/relay-contract.mjs';
import { developmentCall } from '../../src/development.mjs';
export class TestRelay extends AgentRelay {
  constructor(ctx, env) { super(ctx, env); this.boot = crypto.randomUUID(); }
  inspect() { return { boot: this.boot, requests: this.sql.exec('SELECT * FROM requests').toArray(), attempts: this.sql.exec('SELECT * FROM attempts').toArray(), waiters: this.waiters.size }; }
  timeout(id) { for (const [a, w] of this.waiters) if (w.id === id) this.settle(a, { ok: false, kind: 'transport', error: 'simulated waiter timeout' }); }
  async expire() { this.sql.exec('UPDATE requests SET until=0'); await this.alarm(); await this.alarm(); return this.inspect(); }
  stale() { for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); ws.serializeAttachment({ ...a, connected: 0 }); } }
  reset() { this.ctx.abort('test runtime reset'); }
}
// The Durable Object transport is generic; production now connects only dok. These helpers drive a second, test-only instance.
const macStatus = (env) => env.RELAY.getByName('owner-mac').status();
async function macRequest(env, operation, args) {
  validateRelay(operation, args);
  const result = await env.RELAY.getByName('owner-mac').dispatch(operation, args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function macConnect(request, env) {
  const [a, b] = await Promise.all([request.headers.get('authorization') ?? '', 'Bearer ' + env.RELAY_TOKEN].map((x) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(x))));
  if (!crypto.subtle.timingSafeEqual(a, b)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return env.RELAY.getByName('owner-mac').fetch(request);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/relay/connect') return macConnect(request, env);
    if (url.pathname.startsWith('/relay/')) return relayFetch(request, env);
    const stub = env.RELAY.getByName('owner-mac');
    try {
      if (url.pathname === '/dev/call') {
        const { owner, operation, args } = await request.json();
        return Response.json({ value: await developmentCall(env, owner, operation, args) });
      }
      if (url.pathname === '/status') return Response.json(await macStatus(env));
      if (url.pathname === '/inspect') return Response.json(await stub.inspect());
      if (url.pathname === '/expire') return Response.json(await stub.expire());
      if (url.pathname === '/timeout') { await stub.timeout(url.searchParams.get('id')); return Response.json({ ok: true }); }
      if (url.pathname === '/stale') { await stub.stale(); return Response.json({ ok: true }); }
      if (url.pathname === '/reset') { await stub.reset(); return Response.json({ ok: true }); }
      const { operation, args } = await request.json();
      return Response.json({ value: await macRequest(env, operation, args) });
    } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
  },
};
