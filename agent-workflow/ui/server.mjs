// `agent ui`: the dashboard in a normal browser tab, served on 127.0.0.1 only while the command runs.
// A random per-launch token guards both the page and the call endpoint, and the Host header must be the
// loopback address, so other web pages (including DNS-rebinding tricks) cannot drive the agents.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { callTool } from '../mcp.mjs';
import { OPS, defaultContext } from '../ops.mjs';
import { dashboardHtml, webBridge } from './dashboard.mjs';

const same = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function createUiServer({ ctx = defaultContext(), token = randomBytes(18).toString('base64url'), ops = OPS } = {}) {
  const html = dashboardHtml({ bridge: webBridge(token) });
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const { port } = server.address();
    if (!['127.0.0.1', 'localhost'].map((h) => `${h}:${port}`).includes(req.headers.host)) return send(403, { error: 'forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      return same(url.searchParams.get('t'), token) ? send(200, html, 'text/html; charset=utf-8') : send(403, { error: 'missing or wrong token' });
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      if (!same(req.headers['x-agent-ui'], token)) return send(403, { error: 'forbidden' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1e6) return send(413, { error: 'too large' }); }
      let msg; try { msg = JSON.parse(body); } catch { return send(400, { error: 'bad json' }); }
      const op = ops.find((o) => o.name === msg?.name);
      if (!op) return send(404, { error: `unknown tool ${msg?.name}` });
      return send(200, await callTool(op, msg.arguments, ctx));
    }
    return send(404, { error: 'not found' });
  });
  return { server, token };
}

export function startUi({ port = 0, ctx, open = true, spawn } = {}) {
  const { server, token } = createUiServer({ ctx });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
    if (open && spawn) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    resolve({ server, url });
  }));
}
