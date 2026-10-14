#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { boundedBytes, artifactManifest } from '../../agent-workflow/run-artifact-contract.mjs';
import { githubClient, PublicationError } from './github.mjs';
import { prepareBase, prepareReview, observeReview, cleanupMergedReview, publishJob } from './publisher.mjs';

export function serializeByKey() {
  const jobs = new Map();
  return (key, fn) => {
    const next = (jobs.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    jobs.set(key, next);
    return next.finally(() => { if (jobs.get(key) === next) jobs.delete(key); });
  };
}
export async function serve(config) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Invalid Hub endpoint');
  if (fs.statSync(config.github.private_key_file).mode & 0o077) throw Error('App key must be private');
  const github = githubClient(config.github), serial = serializeByKey();
  fs.mkdirSync(config.state, { recursive: true, mode: 0o700 });
  const hub = async (route, body) => {
    let r;
    try { r = await fetch(new URL('/relay/publisher/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30000), headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); } catch { throw new PublicationError('unavailable', true); }
    if (!r.ok) throw new PublicationError('unavailable', true);
    return r;
  };
  let stopping = false, active = false, currentJob = null, heartbeating = false, lastReviewPoll = 0;
  const heartbeat = async () => {
    if (heartbeating) return;
    heartbeating = true;
    try {
      await hub('heartbeat', currentJob ? { run_id: currentJob.run_id, lease: currentJob.lease } : {});
      fs.writeFileSync(config.state + '/heartbeat.json', JSON.stringify({ at: Date.now() }), { mode: 0o600 });
    } catch { /* Stale health and expired leases remain visible to the Hub. */ }
    finally { heartbeating = false; }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.method === 'GET' && req.url === '/health') return res.end(JSON.stringify({ ok: !stopping, active }));
      if (stopping || req.method !== 'POST' || !['/prepare-base', '/prepare-review'].includes(req.url)) throw Error('Unsupported request');
      let text = ''; for await (const b of req) { text += b; if (text.length > 2048) throw Error('Request too large'); }
      const args = JSON.parse(text);
      if (Object.keys(args).some(k => !['repo', 'run_id', 'selection'].includes(k))) throw Error('Invalid request');
      const result = await serial(args.repo, async () => {
        if (req.url === '/prepare-base') return prepareBase(config, github, args);
        const selection = args.selection;
        if (!selection || Object.keys(selection).some(k => !['root', 'pr_number'].includes(k))) throw Error('Invalid selection');
        const thread = await (await hub('resolve-review', { repo: args.repo, ...selection })).json();
        const value = await prepareReview(config, github, args, thread);
        await hub('observe-review', { ...value.source_pr, state: 'open' });
        return value;
      });
      res.end(JSON.stringify(result));
    } catch { res.statusCode = 503; res.end(JSON.stringify({ error: 'Fresh GitHub base unavailable; check review publisher' })); }
  });
  server.requestTimeout = 120000;
  // Recover a stale Unix socket after SIGKILL, but never unlink a live publisher's socket.
  if (fs.existsSync(config.socket)) await new Promise((resolve, reject) => {
    const probe = net.createConnection(config.socket);
    probe.setTimeout(2000, () => { probe.destroy(); reject(Error('Publisher socket is busy')); });
    probe.on('connect', () => { probe.destroy(); reject(Error('Publisher already running')); });
    probe.on('error', e => {
      if (!['ECONNREFUSED', 'ENOENT'].includes(e.code)) return reject(Error('Publisher socket unavailable'));
      try { fs.unlinkSync(config.socket); } catch (error) { if (error.code !== 'ENOENT') return reject(error); }
      resolve();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
  fs.chmodSync(config.socket, 0o600);
  const stop = () => { stopping = true; server.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, 15000);
  try {
    while (!stopping) {
      let job;
      try {
        if (Date.now() - lastReviewPoll >= 60000) {
          lastReviewPoll = Date.now();
          const { threads } = await (await hub('threads')).json();
          for (const thread of threads) {
            try { await serial(thread.repo, async () => {
              const observed = await observeReview(config, github, thread);
              await hub('observe-review', observed);
              if (observed.state === 'merged') await cleanupMergedReview(config, github, thread);
            }); }
            catch { /* Keep the last dated observation; preparation still requires fresh GitHub access. */ }
          }
        }
        job = (await (await hub('claim', {})).json()).job;
        fs.writeFileSync(config.state + '/heartbeat.json', JSON.stringify({ at: Date.now() }), { mode: 0o600 });
        if (job) {
          currentJob = job;
          active = true;
          let result;
          try {
            const r = await hub('artifacts/' + job.run_id);
            const download = artifactManifest(job.receipt, JSON.parse(r.headers.get('x-artifact-manifest') ?? 'null'));
            if (JSON.stringify(download) !== JSON.stringify(job.manifest)) throw new PublicationError('invalid_artifact');
            const bytes = await boundedBytes(r.body, download.size);
            result = await serial(job.receipt.repo, () => publishJob(config, github, job, bytes));
          } catch (e) {
            if (e.code === 'authentication') github.invalidate();
            result = { status: e.retry ? 'retrying' : 'blocked', error_code: e instanceof PublicationError ? e.code : 'invalid_artifact', retry_after_ms: e.delay ?? 0 };
          }
          await hub('finish', { run_id: job.run_id, lease: job.lease, ...result });
          console.log(JSON.stringify({ run_id: job.run_id, status: result.status }));
        }
      } catch { console.error('Publisher contact unavailable; retained jobs will reconcile'); }
      finally { active = false; currentJob = null; }
      if (!stopping) await new Promise(resolve => { const t = setTimeout(resolve, job ? 1000 : 15000); t.unref(); });
    }
  } finally { clearInterval(heartbeatTimer); server.close(); try { fs.unlinkSync(config.socket); } catch {} }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file || fs.statSync(file).mode & 0o077) throw Error('Publisher config must be private');
  await serve(JSON.parse(fs.readFileSync(file, 'utf8')));
}
