import http from 'node:http';
import { dashboardHtml } from '../ui/dashboard.mjs';
import { fixtures } from './fixtures.mjs';

const html = await dashboardHtml(fixtures);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
});
const port = Number(process.env.DEMO_PORT ?? 4174);
server.listen(port, '127.0.0.1', () => console.log(`Agents Hub fixture demo: http://127.0.0.1:${port}/`));
