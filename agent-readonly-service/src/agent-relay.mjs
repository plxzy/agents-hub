import { DurableObject } from 'cloudflare:workers';
import { validateRelay } from '../../agent-workflow/relay-contract.mjs';
import { WIRE, PING, PONG, encode, decode, validId, validateStatus, fingerprint } from '../../agent-workflow/relay-wire.mjs';
const iso = (ms) => Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? new Date(ms).toISOString() : null;
const offline = (now) => ({ online: false, enabled: false, agents: [], observed_at: iso(now), last_seen_at: null, protocol_version: WIRE.version });
const uncertain = (id) => ({ ok: false, kind: 'transport', error: `Relay response unavailable; action may have completed. Retry with the SAME request_id: ${id}` });

export class AgentRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiters = new Map();
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), session TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, until INTEGER NOT NULL, result TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, request TEXT NOT NULL, session TEXT NOT NULL, socket TEXT NOT NULL, expires INTEGER NOT NULL)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }
  one(sql, ...args) { return this.sql.exec(sql, ...args).toArray()[0]; }
  owner() { return this.one('SELECT session FROM owner WHERE id=1')?.session; }
  socket() {
    const owner = this.owner();
    return this.ctx.getWebSockets().find((ws) => ws.readyState === 1 && ws.deserializeAttachment()?.session === owner);
  }
  status() {
    const now = Date.now(), ws = this.socket();
    if (!ws) return offline(now);
    const a = ws.deserializeAttachment();
    const seen = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? a.connected;
    const observation = { observed_at: iso(now), last_seen_at: iso(seen), protocol_version: WIRE.version };
    return Number.isFinite(seen) && seen <= now && now - seen < WIRE.freshness
      ? { online: true, ...a.status, ...observation }
      : { ...offline(now), ...observation, last_known: { ...a.status, observed_at: iso(a.status_at ?? a.connected) } };
  }
  async fetch(request) {
    // Worker authenticates before forwarding. Protocol and ownership are checked before any eviction.
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
    let hello;
    try {
      hello = decode(request.headers.get('x-relay-hello'));
      if (!validId(hello.session) || !['acquire', 'resume'].includes(hello.mode)) throw new Error('Invalid session');
      hello.status = validateStatus(hello.status);
    } catch { return new Response('Incompatible relay protocol', { status: 400 }); }
    return this.ctx.blockConcurrencyWhile(async () => {
      if (hello.mode === 'resume' && this.owner() !== hello.session) return new Response('Session replaced; restart manually', { status: 409 });
      const old = this.ctx.getWebSockets();
      this.sql.exec('INSERT INTO owner(id,session) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session', hello.session);
      await this.ctx.storage.sync();
      for (const ws of old) { this.release(ws); ws.close(4001, 'Session replaced'); }
      const pair = new WebSocketPair();
      const ws = pair[1];
      const socket = crypto.randomUUID();
      this.ctx.acceptWebSocket(ws);
      ws.serializeAttachment({ session: hello.session, socket, status: hello.status, connected: Date.now(), status_at: Date.now() });
      ws.send(encode({ v: 1, type: 'hello', session: hello.session, socket }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }
  async scheduleCleanup() {
    const next = this.one('SELECT MIN(until) AS expiry FROM requests')?.expiry;
    if (next != null) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM attempts WHERE request IN (SELECT id FROM requests WHERE until <= ?)', Date.now());
      this.sql.exec('DELETE FROM requests WHERE until <= ?', Date.now());
    });
    await this.scheduleCleanup();
  }
  async dispatch(operation, args) {
    validateRelay(operation, args);
    const id = args.request_id ?? crypto.randomUUID();
    const fp = await fingerprint(operation, args);
    let row = this.one('SELECT * FROM requests WHERE id=?', id);
    if (row && row.until <= Date.now()) { await this.alarm(); row = undefined; }
    if (row && row.fingerprint !== fp) throw new Error('request_id already belongs to a different action');
    if (row?.result) return JSON.parse(row.result);
    const running = [...this.waiters.values()].find((w) => w.id === id);
    if (running) return running.promise;
    const status = this.status();
    if (!status.online) throw new Error('Mac is offline. No action was queued.');
    if (operation === 'start_run' && (!status.enabled || !status.agents.includes(args.agent))) throw new Error('Remote runs are off or this agent is not remote-allowed.');
    if (this.waiters.size >= WIRE.capacity) throw new Error('Relay is busy. No action was queued.');
    const ws = this.socket(), a = ws.deserializeAttachment();
    const attempt = crypto.randomUUID(), expires = Date.now() + WIRE.attempt;
    const message = encode({ v: 1, type: 'request', session: a.session, socket: a.socket, attempt, id, operation, args, expires });
    this.ctx.storage.transactionSync(() => {
      if (!row) this.sql.exec('INSERT INTO requests(id,fingerprint,until) VALUES(?,?,?)', id, fp, expires + WIRE.retention);
      this.sql.exec('INSERT INTO attempts(id,request,session,socket,expires) VALUES(?,?,?,?,?)', attempt, id, a.session, a.socket, expires);
    });
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const timer = setTimeout(() => this.settle(attempt, uncertain(id)), WIRE.attempt);
    this.waiters.set(attempt, { id, socket: a.socket, promise, resolve, timer });
    try {
      await this.scheduleCleanup();
      await this.ctx.storage.sync(); // dispatch is durable BEFORE send
      if (this.socket() !== ws || expires <= Date.now()) this.settle(attempt, uncertain(id));
      else ws.send(message);
    } catch { this.settle(attempt, uncertain(id)); }
    return promise;
  }
  settle(attempt, result) {
    const waiter = this.waiters.get(attempt);
    if (!waiter) return;
    clearTimeout(waiter.timer); this.waiters.delete(attempt); waiter.resolve(result);
  }
  release(ws) {
    const socket = ws.deserializeAttachment()?.socket;
    for (const [id, waiter] of this.waiters) if (waiter.socket === socket) this.settle(id, uncertain(waiter.id));
  }
  async webSocketMessage(ws, message) {
    try {
      const m = decode(message), a = ws.deserializeAttachment();
      if (ws !== this.socket() || m.session !== a.session || m.socket !== a.socket) throw new Error('Stale connection');
      if (m.type === 'status') { ws.serializeAttachment({ ...a, status: validateStatus(m.status), status_at: Date.now() }); return; }
      if (m.type !== 'result' || !validId(m.attempt) || !m.result || typeof m.result.ok !== 'boolean'
        || (!m.result.ok && (typeof m.result.error !== 'string' || !['terminal', 'interrupted', 'rejected'].includes(m.result.kind)))) throw new Error('Invalid result');
      encode(m.result, WIRE.resultBytes);
      const attempt = this.one('SELECT * FROM attempts WHERE id=?', m.attempt);
      if (!attempt || attempt.session !== a.session || attempt.socket !== a.socket || attempt.request !== m.id) throw new Error('Unknown dispatch');
      const row = this.one('SELECT * FROM requests WHERE id=?', m.id);
      if (!row || row.until <= Date.now()) return; // retention expired; local journal is still authoritative
      // No waiter is required: a valid late completion is recoverable by an explicit retry.
      const terminal = m.result.ok || m.result.kind === 'terminal';
      if (terminal && !row.result) this.sql.exec('UPDATE requests SET result=? WHERE id=?', encode(m.result), m.id);
      await this.ctx.storage.sync(); // receipt is durable BEFORE ack / returning success
      ws.send(encode({ v: 1, type: 'ack', session: a.session, socket: a.socket, attempt: m.attempt }));
      const result = row.result ? JSON.parse(row.result) : m.result;
      for (const [id, w] of this.waiters) if (w.id === m.id) this.settle(id, result);
    } catch { this.release(ws); ws.close(1008, 'Invalid relay message'); }
  }
  webSocketClose(ws) { this.release(ws); }
  webSocketError(ws) { this.release(ws); ws.close(1011, 'Relay connection failed'); }
}
