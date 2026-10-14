import { artifactIdentity, ARTIFACT_RUN_ID } from '../../agent-workflow/run-artifact-contract.mjs';
import { publicPublication } from '../../agent-workflow/review-publication-contract.mjs';
import { readArtifact, downloadArtifact } from './run-artifacts.mjs';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const branch = root => `review/agents/${root}`;
async function repository(env, repo) {
  if (!env.REVIEW_PUBLISHER_TOKEN) return null;
  return env.DB.prepare('SELECT * FROM review_repositories WHERE repo = ?').bind(repo).first();
}
async function rawRun(env, id) {
  const row = await env.DB.prepare('SELECT receipt FROM runs WHERE run_id = ?').bind(id).first();
  return row ? JSON.parse(row.receipt) : null;
}
async function rootOf(env, r) {
  // Persist the mapping with each job so pruning old run receipts cannot detach a PR.
  for (let i = 0; i < 128; i++) {
    const known = await env.DB.prepare('SELECT root FROM review_publications WHERE run_id = ?').bind(r.run_id).first();
    if (known) return known.root;
    if (ARTIFACT_RUN_ID.test(r.review_conversation_id ?? '')) return r.review_conversation_id;
    if (!r.continued_from) return r.run_id;
    const parent = await rawRun(env, r.continued_from);
    if (!parent || parent.repo !== r.repo) throw Error('Review ancestry unavailable; preserve the saved artifact');
    r = parent;
  }
  throw Error('Review ancestry exceeds supported depth');
}

export async function ensurePublication(env, receipt, { explicit = false } = {}) {
  const target = await repository(env, receipt?.repo);
  if (!target) { if (explicit) throw Error('Repository is not enabled for GitHub publication'); return; }
  if (!explicit && Date.parse(receipt.started) < Date.parse(target.enabled_after)) return;
  try { artifactIdentity(receipt); } catch { if (explicit) throw Error('Run has no completed changed review'); return; }
  const root = await rootOf(env, receipt), manifest = await readArtifact(env, receipt);
  await env.DB.prepare(`INSERT INTO review_publications(run_id,repo,root,commit_sha,receipt,manifest,started,status)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING`).bind(receipt.run_id, receipt.repo, root, receipt.commit,
    JSON.stringify(receipt), manifest ? JSON.stringify(manifest) : null, receipt.started, manifest ? 'queued' : 'waiting_artifact').run();
  const existing = await env.DB.prepare('SELECT * FROM review_publications WHERE run_id=?').bind(receipt.run_id).first();
  if (existing.commit_sha !== receipt.commit || existing.repo !== receipt.repo || existing.root !== root) throw Error('Publication identity conflict');
  if (manifest) await env.DB.prepare(`UPDATE review_publications SET manifest=?,status='queued',error=NULL,due=0
    WHERE run_id=? AND (status='waiting_artifact' OR (?=1 AND status IN ('blocked','retrying')))`)
    .bind(JSON.stringify(manifest), receipt.run_id, explicit ? 1 : 0).run();
  return readPublication(env, receipt);
}
export async function publishReview(env, args) {
  if (!args || Object.keys(args).some(k => k !== 'run_id') || !ARTIFACT_RUN_ID.test(args.run_id ?? '')) throw Error('Invalid review request');
  const r = await rawRun(env, args.run_id);
  if (!r) throw Error('Unknown run');
  return { run_id: r.run_id, publication: await ensurePublication(env, r, { explicit: true }) };
}
export async function readPublication(env, r) {
  if (!env.REVIEW_PUBLISHER_TOKEN) return undefined;
  const row = await env.DB.prepare(`SELECT p.*,t.github FROM review_publications p
    JOIN review_repositories t ON t.repo=p.repo WHERE p.run_id=?`).bind(r.run_id).first();
  if (row) return publicPublication({ status: row.status, github: row.github, branch: branch(row.root), commit: row.commit_sha,
    conversation_id: row.root, pr_number: row.pr_number, pr_url: row.pr_url, published_at: row.published_at,
    error: row.error, ...(row.due ? { next_retry_at: new Date(row.due).toISOString() } : {}) });
  if (r.source_review && r.commit === r.source_review.commit) return readPublication(env, { run_id: r.source_review.run_id });
  if (r.status === 'completed' && !r.review_ref) return { status: 'not_applicable' };
  return undefined;
}
export async function publicationHealth(env) {
  if (!env.REVIEW_PUBLISHER_TOKEN) return { enabled: false };
  const h = await env.DB.prepare('SELECT observed_at FROM review_publisher_health WHERE id=1').first();
  const { results } = await env.DB.prepare('SELECT status,COUNT(*) AS count FROM review_publications GROUP BY status').all();
  return { enabled: true, online: !!h && Date.now() - Date.parse(h.observed_at) < 60000,
    observed_at: h?.observed_at ?? null, counts: Object.fromEntries(results.map(r => [r.status, r.count])) };
}

async function claim(env) {
  const now = Date.now(), lease = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO review_publisher_health(id,observed_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at')
    .bind(new Date(now).toISOString()).run();
  // One atomic conditional update. A root's earlier unfinished job blocks later jobs.
  const job = await env.DB.prepare(`UPDATE review_publications SET status='publishing',lease=?,lease_until=?,attempts=attempts+1
    WHERE run_id=(SELECT p.run_id FROM review_publications p JOIN review_repositories c ON c.repo=p.repo
      WHERE p.manifest IS NOT NULL AND ((p.status IN ('queued','retrying') AND p.due<=?) OR (p.status='publishing' AND p.lease_until<?))
      AND NOT EXISTS(SELECT 1 FROM review_publications earlier WHERE earlier.root=p.root AND earlier.run_id<>p.run_id
        AND (earlier.started<p.started OR (earlier.started=p.started AND earlier.run_id<p.run_id)) AND earlier.status<>'published')
      ORDER BY p.started,p.run_id LIMIT 1) RETURNING *`).bind(lease, now + 300000, now, now).first();
  if (!job) return null;
  const target = await repository(env, job.repo);
  const thread = await env.DB.prepare('SELECT * FROM review_threads WHERE root=?').bind(job.root).first();
  return { run_id: job.run_id, root: job.root, lease, github: target.github, base: target.base,
    branch: branch(job.root), receipt: JSON.parse(job.receipt), manifest: JSON.parse(job.manifest), thread };
}
async function finish(env, value) {
  if (!ARTIFACT_RUN_ID.test(value.run_id ?? '') || typeof value.lease !== 'string') throw Error('Invalid publication result');
  const job = await env.DB.prepare("SELECT * FROM review_publications WHERE run_id=? AND lease=? AND status='publishing' AND lease_until>?")
    .bind(value.run_id, value.lease, Date.now()).first();
  if (!job) throw Error('Publication lease expired; reconcile before retrying');
  if (value.status !== 'published') {
    const retry = value.status === 'retrying';
    if (!retry && value.status !== 'blocked') throw Error('Invalid publication status');
    const codes = { authentication: 'GitHub credentials unavailable; check the publisher App installation.',
      conflict: 'Review branch or PR changed; inspect GitHub before continuing.',
      invalid_artifact: 'Saved review verification failed; preserve the original artifact.',
      unavailable: 'GitHub or artifact service unavailable; publication will retry.',
      rejected: 'GitHub refused publication; inspect repository permissions and rules.' };
    const error = codes[value.error_code] ?? codes.rejected;
    const due = retry ? Date.now() + Math.max(Math.min(900000, 15000 * 2 ** Math.min(job.attempts, 6)), Math.min(3600000, Math.max(0, Number(value.retry_after_ms) || 0))) : 0;
    await env.DB.prepare('UPDATE review_publications SET status=?,error=?,due=?,lease=NULL,lease_until=0 WHERE run_id=? AND lease=?')
      .bind(retry ? 'retrying' : 'blocked', error, due, job.run_id, value.lease).run();
    return { ok: true };
  }
  const target = await repository(env, job.repo);
  if (value.commit !== job.commit_sha || !Number.isSafeInteger(value.pr_number) || value.pr_number < 1
    || value.pr_url !== `https://github.com/${target.github}/pull/${value.pr_number}`) throw Error('Publication result mismatch');
  // Lease predicate is repeated within the transaction, including the thread write.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO review_threads(root,repo,branch,commit_sha,pr_number,pr_url)
      SELECT root,repo,?,commit_sha,?,? FROM review_publications WHERE run_id=? AND lease=? AND lease_until>?
      ON CONFLICT(root) DO UPDATE SET commit_sha=excluded.commit_sha,pr_number=excluded.pr_number,pr_url=excluded.pr_url`)
      .bind(branch(job.root), value.pr_number, value.pr_url, job.run_id, value.lease, Date.now()),
    env.DB.prepare(`UPDATE review_publications SET status='published',pr_number=?,pr_url=?,published_at=?,error=NULL,due=0,lease=NULL,lease_until=0
      WHERE run_id=? AND lease=? AND lease_until>?`).bind(value.pr_number, value.pr_url, new Date().toISOString(), job.run_id, value.lease, Date.now()),
  ]);
  return { ok: true };
}
export async function publisherFetch(request, env) {
  if (!env.REVIEW_PUBLISHER_TOKEN) return json({ error: 'unauthorized' }, 401);
  const digest = x => crypto.subtle.digest('SHA-256', new TextEncoder().encode(x));
  const [a, b] = await Promise.all([digest(request.headers.get('authorization') ?? ''), digest('Bearer ' + env.REVIEW_PUBLISHER_TOKEN)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return json({ error: 'unauthorized' }, 401);
  const p = new URL(request.url).pathname;
  try {
    if (p === '/relay/publisher/heartbeat' && request.method === 'POST') {
      const value = await request.json();
      await env.DB.prepare('INSERT INTO review_publisher_health(id,observed_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at')
        .bind(new Date().toISOString()).run();
      if (value.run_id && value.lease) {
        const renewed = await env.DB.prepare("UPDATE review_publications SET lease_until=? WHERE run_id=? AND lease=? AND status='publishing' AND lease_until>? RETURNING run_id")
          .bind(Date.now() + 300000, value.run_id, value.lease, Date.now()).first();
        if (!renewed) throw Error('Lease expired');
      }
      return json({ ok: true });
    }
    if (p === '/relay/publisher/claim' && request.method === 'POST') return json({ job: await claim(env) });
    if (p === '/relay/publisher/finish' && request.method === 'POST') {
      const bytes = await request.text(); if (bytes.length > 2048) throw Error('Result too large');
      return json(await finish(env, JSON.parse(bytes)));
    }
    const match = p.match(/^\/relay\/publisher\/artifacts\/(r-[\w-]+)$/);
    if (match && request.method === 'GET') {
      const job = await env.DB.prepare('SELECT receipt FROM review_publications WHERE run_id=?').bind(match[1]).first();
      if (!job) return json({ error: 'Unknown publication' }, 404);
      return downloadArtifact(env, JSON.parse(job.receipt));
    }
    return json({ error: 'not_found' }, 404);
  } catch { return json({ error: 'Publication request refused' }, 409); }
}
