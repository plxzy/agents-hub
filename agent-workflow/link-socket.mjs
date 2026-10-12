import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import timers from 'node:timers/promises';
import { WIRE, PING, PONG, encode, decode, validId, validateStatus } from './relay-wire.mjs';

// Foreground-only. A process acquires once; every ordinary reconnect must resume its durable ownership.
export async function serveSocket({ readConfig, execute, publish, signal, log = console.log, Socket = WebSocket,
  session = randomUUID(), host = 'mac', onState = () => {} }) {
  if (!['mac', 'dok-dev'].includes(host)) throw new Error('Unknown relay host');
  let acquired = false, failures = 0, commands = Promise.resolve(), queued = 0;
  let publishing = false;
  const state = (value) => {
    try { onState({ session, ...value, observed_at: new Date().toISOString() }); }
    catch { log('Relay health state publication failed; relay remains available.'); }
  };
  const snapshot = async () => {
    if (publishing || signal?.aborted) return;
    publishing = true;
    try { await publish(); } catch { log('Snapshot publication failed; relay remains available.'); }
    finally { publishing = false; }
  };
  const snapshots = setInterval(() => { void snapshot(); }, 60000);
  void snapshot();
  try {
    while (!signal?.aborted) {
      const config = readConfig();
      const url = new URL(config.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Relay endpoint must be a credential-free HTTPS URL');
      url.protocol = 'wss:'; url.pathname = url.pathname.replace(/\/$/, '') + (host === 'dok-dev' ? '/relay/dok-dev/connect' : '/relay/connect');
      const hello = { v: 1, session, mode: acquired ? 'resume' : 'acquire', status: validateStatus({ enabled: config.enabled === true, agents: config.agents }) };
      acquired = true; // even a lost HTTP/hello response must not reacquire ownership
      state({ hub_ready: false, last_pong_at: null });
      const result = await new Promise((resolve) => {
        let done = false, socketId, ready = false, lastPong = Date.now(), statusText = JSON.stringify(hello.status), fatal;
        const pending = new Map();
        const ws = new Socket(url, { headers: { authorization: 'Bearer ' + config.token, 'x-relay-hello': encode(hello) },
          handshakeTimeout: WIRE.handshake, maxPayload: WIRE.messageBytes, followRedirects: false, perMessageDeflate: false });
        const send = (m) => { if (ws.readyState === 1) ws.send(encode({ v: 1, session, socket: socketId, ...m })); };
        const abort = () => finish();
        const finish = (reason) => {
          if (done) return; done = true;
          clearTimeout(handshake); clearInterval(tick);
          signal?.removeEventListener('abort', abort);
          pending.clear();
          if (ws.readyState !== 3) ws.terminate();
          state({ hub_ready: false, last_pong_at: null, fatal: Boolean(reason) });
          resolve({ fatal: reason ?? fatal, ready });
        };
        const fresh = () => {
          if (Date.now() - lastPong < WIRE.freshness) return true;
          finish(); return false;
        };
        const handshake = setTimeout(() => finish(), WIRE.handshake);
        const tick = setInterval(() => {
          if (!ready || done) return;
          try {
            if (!fresh()) return;
            if (Date.now() - lastPing >= WIRE.keepalive) { ws.send(PING); lastPing = Date.now(); }
            const c = readConfig();
            const status = validateStatus({ enabled: c.enabled === true, agents: c.agents });
            if (JSON.stringify(status) !== statusText) { send({ type: 'status', status }); statusText = JSON.stringify(status); }
            for (const [id, p] of pending) {
              if (Date.now() >= p.until) pending.delete(id);
              else if (Date.now() - p.sent >= 5000) { send(p.message); p.sent = Date.now(); }
            }
          } catch { finish('Invalid local relay configuration; fix it and restart.'); }
        }, 1000);
        let lastPing = 0;
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) finish();
        ws.on('unexpected-response', (_request, response) => {
          response.resume();
          finish([400, 401, 403, 404, 409, 426].includes(response.statusCode) || (response.statusCode >= 300 && response.statusCode < 400)
            ? `Relay refused connection (HTTP ${response.statusCode}); fix credentials/protocol or restart manually.` : undefined);
        });
        ws.on('error', () => finish()); // do not log URL, headers, or credentials
        ws.on('close', (code) => finish([4001, 1008].includes(code) ? 'Relay session replaced or rejected; restart manually to acquire ownership.' : undefined));
        ws.on('message', (data, binary) => {
          if (done) return;
          try {
            if (binary) throw new Error('Binary message');
            const text = data.toString('utf8');
            if (text === PONG) { lastPong = Date.now(); state({ hub_ready: true, last_pong_at: new Date(lastPong).toISOString(), fatal: false }); return; }
            const m = decode(text);
            if (m.type === 'hello' && !ready && m.session === session && validId(m.socket)) {
              socketId = m.socket; ready = true; clearTimeout(handshake); state({ hub_ready: true, last_pong_at: null, fatal: false }); ws.send(PING); lastPing = Date.now();
              log(host === 'dok-dev' ? 'dok-dev linked to Agents Hub.' : 'Agents Hub linked over WebSocket (foreground; Ctrl-C disconnects).'); return;
            }
            if (!ready || m.session !== session || m.socket !== socketId) throw new Error('Invalid socket identity');
            if (m.type === 'ack') { pending.delete(m.attempt); return; }
            if (m.type !== 'request' || !validId(m.attempt) || !validId(m.id) || !Number.isFinite(m.expires)) throw new Error('Invalid request');
            if (!fresh()) return; // I/O can arrive before overdue timers after suspend.
            if (queued + pending.size >= WIRE.capacity) { send({ type: 'result', attempt: m.attempt, id: m.id, result: { ok: false, kind: 'rejected', error: 'Mac relay is busy; retry explicitly.' } }); return; }
            queued++;
            commands = commands.then(async () => {
              if (done || signal?.aborted) return; // disconnect cancels only unstarted commands
              if (!fresh()) return; // Waiting behind another command can also outlive liveness.
              let value;
              try {
                value = m.expires <= Date.now() ? { ok: false, kind: 'rejected', error: 'Transport attempt expired before execution; retry explicitly.' }
                  : await execute(m, readConfig());
                encode(value, WIRE.resultBytes);
              } catch { value = { ok: false, kind: 'interrupted', error: 'Local command interrupted; inspect the journal before retrying.' }; }
              if (!done) {
                const message = { type: 'result', attempt: m.attempt, id: m.id, result: value };
                pending.set(m.attempt, { message, until: m.expires + WIRE.retention, sent: Date.now() }); send(message);
              }
            }).catch(() => finish()).finally(() => { queued--; });
          } catch { finish('Invalid relay protocol; restart after checking the server version.'); }
        });
      });
      if (result.fatal) throw new Error(result.fatal);
      if (signal?.aborted) break;
      failures = result.ready ? 0 : failures + 1;
      const cap = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      log('Relay disconnected; resuming the same process session.');
      try { await timers.setTimeout(Math.max(1000, cap * (0.5 + Math.random() * 0.5)), undefined, { signal }); }
      catch (e) { if (e.name !== 'AbortError') throw e; }
    }
  } finally { clearInterval(snapshots); await commands; }
}
