// Disposable loopback transport only. Never imported by production or connected to a hosted relay.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { serveForeground } from '../link.mjs';
import { serveSocket } from '../link-socket.mjs';
import { PING, PONG } from '../relay-wire.mjs';
const [role, arg, initialOwner] = process.argv.slice(2);
const token = 'disposable-plan-1b-token-not-a-secret';
const report = value => process.send?.(value);
if (role === 'server') {
  let owner = initialOwner, current;
  const server = new WebSocketServer({ host: '127.0.0.1', port: Number(arg), verifyClient(info, done) {
    let hello;
    try { hello = JSON.parse(info.req.headers['x-relay-hello']); } catch { return done(false, 400); }
    if (info.req.headers.authorization !== 'Bearer ' + token) return done(false, 401);
    if (hello.mode === 'resume' && hello.session !== owner) return done(false, 409);
    done(true);
  } });
  server.on('listening', () => report({ event: 'listening', port: server.address().port }));
  server.on('connection', (ws, req) => {
    const hello = JSON.parse(req.headers['x-relay-hello']); owner = hello.session;
    current?.close(4001, 'fixture replacement'); current = ws;
    ws.send(JSON.stringify({ v: 1, type: 'hello', session: owner, socket: 'fixture-socket' }));
    report({ event: 'connected', session: owner, mode: hello.mode, status: hello.status });
    ws.on('message', data => { if (data.toString() === PING) { ws.send(PONG); report({ event: 'pong' }); } });
    ws.on('close', () => report({ event: 'closed' }));
  });
  process.on('message', m => { if (m === 'drop') current?.terminate(); });
} else if (role === 'client') {
  // The production client still requires HTTPS/WSS. Only this disposable localhost fixture uses plaintext.
  class LoopbackSocket extends WebSocket {
    constructor(url, options) {
      if (url.hostname !== '127.0.0.1') throw new Error('Fixture must stay on loopback');
      const local = new URL(url); local.protocol = 'ws:'; super(local, options);
    }
  }
  const configFile = path.join(arg, 'link.json');
  const before = ['SIGINT', 'SIGTERM'].map(sig => process.listenerCount(sig));
  try {
    await serveForeground({ configFile, serve: options => serveSocket({ ...options, Socket: LoopbackSocket,
      publish: async () => {}, execute: async () => { throw new Error('No operations permitted in fixture'); }, log: () => {} }) });
    report({ event: 'stopped', signalsRestored: ['SIGINT', 'SIGTERM'].every((sig, i) => process.listenerCount(sig) === before[i]),
      lockExists: fs.existsSync(path.join(arg, 'link.lock')) });
    process.disconnect();
  } catch (e) { report({ event: 'refused', error: e.message }); process.exitCode = 1; process.disconnect(); }
} else throw new Error('Unknown fixture role');
