// Test-only entrypoint. Never imported by the production Worker.
import { AgentRelay } from '../../src/agent-relay.mjs';
import { relayFetch, requestRelay, relayStatus } from '../../src/relay.mjs';
export class TestRelay extends AgentRelay {
  constructor(ctx, env) { super(ctx, env); this.boot = crypto.randomUUID(); }
  inspect() { return { boot: this.boot, requests: this.sql.exec('SELECT * FROM requests').toArray(), attempts: this.sql.exec('SELECT * FROM attempts').toArray(), waiters: this.waiters.size }; }
  timeout(id) { for (const [a, w] of this.waiters) if (w.id === id) this.settle(a, { ok: false, kind: 'transport', error: 'simulated waiter timeout' }); }
  async expire() { this.sql.exec('UPDATE requests SET until=0'); await this.alarm(); await this.alarm(); return this.inspect(); }
  stale() { for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); ws.serializeAttachment({ ...a, connected: 0 }); } }
  reset() { this.ctx.abort('test runtime reset'); }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/relay/')) return relayFetch(request, env);
    const stub = env.RELAY.getByName('owner-mac');
    try {
      if (url.pathname === '/status') return Response.json(await relayStatus(env));
      if (url.pathname === '/inspect') return Response.json(await stub.inspect());
      if (url.pathname === '/expire') return Response.json(await stub.expire());
      if (url.pathname === '/timeout') { await stub.timeout(url.searchParams.get('id')); return Response.json({ ok: true }); }
      if (url.pathname === '/stale') { await stub.stale(); return Response.json({ ok: true }); }
      if (url.pathname === '/reset') { await stub.reset(); return Response.json({ ok: true }); }
      const { operation, args } = await request.json();
      return Response.json({ value: await requestRelay(env, operation, args) });
    } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
  },
};
