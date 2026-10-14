import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

const RUN = 'r-20261014T020744Z-71aa46', NEXT = 'r-20261014T030744Z-71aa47';
async function runtime(t) {
  const bundle = await build({ entryPoints: [new URL('./fixtures/hub-runtime.mjs', import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', external: ['cloudflare:workers'], platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'publication-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], r2Buckets: ['RUN_ARTIFACTS'], durableObjects: { RELAY: { className: 'AgentRelay', useSQLite: true } },
    bindings: { REVIEW_PUBLISHER_TOKEN: 'publisher-test', DOK_RELAY_TOKEN: 'dok-test', MAC_TOKEN: 'mac-test', DEVELOPMENT_ENABLED: 'true' } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql'))) {
    for (const sql of fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  await db.prepare("INSERT INTO review_repositories VALUES('vm','owner/vm','main','2026-10-14T00:00:00Z')").run();
  const call = (route, body, token = 'publisher-test', headers = {}) => mf.dispatchFetch('https://test' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const tool = async (name, args = {}) => (await (await mf.dispatchFetch('https://test/mcp', { method: 'POST', body: JSON.stringify({ id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const read = async id => JSON.parse((await tool('get_run', { run_id: id })).content[0].text);
  const post = r => call('/relay/dok-dev/runs', r, 'dok-test');
  const upload = async r => {
    const bytes = Buffer.from(`# v2 git bundle\n-${r.base_commit} base\n${r.commit} refs/heads/export-${r.run_id}\n\nbody`);
    const manifest = { version: 1, run_id: r.run_id, repo: r.repo, commit: r.commit, base_commit: r.base_commit,
      review_ref: r.review_ref, bundle_ref: `refs/heads/export-${r.run_id}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const res = await mf.dispatchFetch('https://test/relay/dok-dev/artifacts/' + r.run_id, { method: 'PUT', body: bytes,
      headers: { authorization: 'Bearer dok-test', 'x-artifact-manifest': JSON.stringify(manifest) } });
    assert.equal(res.status, 200, await res.clone().text()); return manifest;
  };
  return { mf, db, call, tool, read, post, upload };
}
function receipt(id = RUN) {
  return { run_id: id, agent: 'vm', runner: 'dok', status: 'completed', started: id === RUN ? '2026-10-14T02:07:44Z' : '2026-10-14T03:07:44Z',
    repo: 'vm', commit: 'b'.repeat(40), base_commit: 'a'.repeat(40), review_ref: `refs/heads/review/runs/${id}`, output: 'Tests passed' };
}
test('publication survives duplicate receipts, exclusive claims, lease expiry and follow-ups', async t => {
  const { db, call, tool, read, post, upload } = await runtime(t), r = receipt();
  assert.equal((await post(r)).status, 200);
  assert.equal((await read(RUN)).publication.status, 'waiting_artifact');
  assert.equal((await call('/relay/publisher/claim', {})).status, 200);
  await upload(r); await upload(r); await post(r);
  const claims = await Promise.all([call('/relay/publisher/claim', {}), call('/relay/publisher/claim', {})]);
  const jobs = (await Promise.all(claims.map(r => r.json()))).map(x => x.job).filter(Boolean);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].receipt.commit, r.commit);
  const first = jobs[0];
  assert.equal((await call('/relay/publisher/finish', { run_id: RUN, lease: 'wrong', status: 'published' })).status, 409);
  const next = { ...receipt(NEXT), continued_from: RUN, base_commit: r.commit, commit: 'c'.repeat(40) };
  await post(next); await upload(next);
  assert.equal((await (await call('/relay/publisher/claim', {})).json()).job, null);
  await db.prepare('UPDATE review_publications SET lease_until=0 WHERE run_id=?').bind(RUN).run();
  const recovered = (await (await call('/relay/publisher/claim', {})).json()).job;
  assert.equal(recovered.run_id, RUN); assert.notEqual(recovered.lease, first.lease);
  const result = { run_id: RUN, lease: recovered.lease, status: 'published', commit: r.commit, pr_number: 5, pr_url: 'https://github.com/owner/vm/pull/5' };
  assert.equal((await call('/relay/publisher/finish', { ...result, pr_url: 'https://evil.test/5' })).status, 409);
  assert.equal((await call('/relay/publisher/finish', result)).status, 200);
  await post(r);
  assert.equal((await read(RUN)).publication.status, 'published');
  assert.equal(JSON.parse((await tool('list_runs')).content[0].text).runs.find(r => r.run_id === RUN).publication.pr_number, 5);
  const follow = (await (await call('/relay/publisher/claim', {})).json()).job;
  assert.equal(follow.root, RUN); assert.equal(follow.thread.pr_number, 5); assert.equal(follow.thread.commit_sha, r.commit);
  assert.equal((await call('/relay/publisher/heartbeat', { run_id: NEXT, lease: follow.lease })).status, 200);
  assert.equal((await call('/relay/publisher/finish', { run_id: NEXT, lease: follow.lease, status: 'blocked', error_code: 'authentication' })).status, 200);
  assert.equal((await read(NEXT)).status, 'completed'); assert.equal((await read(NEXT)).publication.status, 'blocked');
  const retried = await tool('publish_review', { run_id: NEXT }); assert.equal(retried.isError, undefined);
  assert.equal((await read(NEXT)).publication.status, 'queued');
});
test('auth boundaries, activation cutoff, unchanged runs and explicit backfills', async t => {
  const { call, tool, post, upload, read, db } = await runtime(t);
  assert.equal((await call('/relay/publisher/claim', {}, 'dok-test')).status, 401);
  assert.equal((await call('/relay/publisher/claim', {}, 'mac-test')).status, 401);
  assert.equal((await call('/relay/dok-dev/runs', receipt(), 'publisher-test')).status, 401);
  const old = { ...receipt(), started: '2026-10-13T12:00:00Z' };
  await post(old); await upload(old); assert.equal((await read(RUN)).publication, undefined);
  assert.equal((await tool('publish_review', { run_id: RUN, repo: 'other' })).isError, true);
  assert.equal((await tool('publish_review', { run_id: RUN })).isError, undefined);
  assert.equal((await read(RUN)).publication.status, 'queued');
  const unchanged = { ...receipt(NEXT), review_ref: undefined, commit: old.commit, source_review: {
    run_id: RUN, commit: old.commit, base_commit: old.base_commit, review_ref: old.review_ref } };
  await post(unchanged); assert.equal((await read(NEXT)).publication.status, 'queued');
  const counts = await db.prepare('SELECT COUNT(*) AS n FROM review_publications').first(); assert.equal(counts.n, 1);
  assert.equal((await tool('publish_review', { run_id: NEXT })).isError, true);
});

test('PR observations remain separate from historical publication and pending work blocks selection', async t => {
  const { call, post, upload, read } = await runtime(t), r = receipt();
  await post(r); await upload(r);
  const job = (await (await call('/relay/publisher/claim', {})).json()).job;
  await call('/relay/publisher/finish', { run_id: RUN, lease: job.lease, status: 'published', commit: r.commit, pr_number: 5, pr_url: 'https://github.com/owner/vm/pull/5' });
  const selected = await (await call('/relay/publisher/resolve-review', { repo: 'vm', pr_number: 5 })).json();
  assert.equal(selected.root, RUN);
  const review = { root: RUN, github: 'owner/vm', pr_number: 5, branch: `review/agents/${RUN}`, commit: 'd'.repeat(40), observed_at: '2026-10-14T12:00:00Z', state: 'open' };
  assert.equal((await call('/relay/publisher/observe-review', review)).status, 200);
  let current = await read(RUN);
  assert.equal(current.commit, r.commit); assert.equal(current.publication.commit, r.commit);
  assert.equal(current.review.commit, review.commit); assert.equal(current.next_action.pr_number, 5);
  const noEdit = { ...receipt(NEXT), review_conversation_id: RUN, continued_from: RUN, source_pr: review,
    review_ref: undefined, base_commit: review.commit, commit: review.commit, changed_files: [] };
  await post(noEdit); current = await read(NEXT);
  assert.equal(current.source_pr.commit, review.commit); assert.equal(current.review.pr_number, 5); assert.equal(current.next_action.pr_number, 5);
  await call('/relay/publisher/observe-review', { ...review, state: 'merged' });
  assert.equal((await read(NEXT)).next_action.tool, undefined);
  const blocked = { ...receipt(NEXT), review_conversation_id: RUN, base_commit: review.commit, commit: 'e'.repeat(40) };
  await post(blocked);
  assert.equal((await call('/relay/publisher/resolve-review', { repo: 'vm', root: RUN })).status, 409);
  assert.equal((await call('/relay/publisher/observe-review', { ...review, github: 'foreign/repo' })).status, 409);
});

test('panel briefs read publications and reviews in bulk with the same result as one-run reads', async t => {
  const { call, post, upload, read, tool } = await runtime(t), r = receipt();
  await post(r); await upload(r);
  const job = (await (await call('/relay/publisher/claim', {})).json()).job;
  await call('/relay/publisher/finish', { run_id: RUN, lease: job.lease, status: 'published', commit: r.commit, pr_number: 5, pr_url: 'https://github.com/owner/vm/pull/5' });
  const review = { root: RUN, github: 'owner/vm', pr_number: 5, branch: `review/agents/${RUN}`, commit: 'd'.repeat(40), observed_at: '2026-10-14T12:00:00Z', state: 'open' };
  await call('/relay/publisher/observe-review', review);
  // A no-edit continuation (root from review_conversation_id) and a plain completed run without a review ref.
  await post({ ...receipt(NEXT), review_conversation_id: RUN, continued_from: RUN, source_pr: review, review_ref: undefined, base_commit: review.commit, commit: review.commit, changed_files: [] });
  const PLAIN = 'r-20261014T040744Z-71aa48', CHAIN = 'r-20261014T050744Z-71aa49';
  await post({ run_id: PLAIN, agent: 'helper', status: 'completed', started: '2026-10-14T04:07:44Z', output: 'ok' });
  // A continuation without a conversation id: its root comes from walking continued_from.
  await post({ ...receipt(CHAIN), started: '2026-10-14T05:07:44Z', continued_from: NEXT, review_ref: undefined, commit: review.commit, base_commit: review.commit, changed_files: [] });
  const panel = JSON.parse((await tool('panel_data')).content[0].text);
  assert.equal(panel.runs.find((x) => x.run_id === CHAIN).review?.pr_number, 5);
  for (const id of [RUN, NEXT, PLAIN, CHAIN]) {
    const brief = panel.runs.find((x) => x.run_id === id), one = await read(id);
    assert.deepEqual(brief.publication, one.publication, `publication of ${id}`);
    assert.deepEqual(brief.review, one.review, `review of ${id}`);
  }
  assert.equal(panel.runs.find((x) => x.run_id === RUN).publication.pr_number, 5);
  assert.equal(panel.runs.find((x) => x.run_id === NEXT).review.pr_number, 5);
  assert.equal(panel.runs.find((x) => x.run_id === PLAIN).publication.status, 'not_applicable');
});

test('panel_data carries health and answers a poll with an unchanged version until something changes', async t => {
  const { post, tool } = await runtime(t);
  await post(receipt());
  const first = JSON.parse((await tool('panel_data')).content[0].text);
  assert.match(first.version, /^[a-f0-9]{16}$/); assert.equal(first.hub_panel, true);
  assert.ok(first.health?.relay && first.health?.execution, 'health comes with the panel');
  const same = await tool('panel_data', { since: first.version });
  assert.deepEqual(JSON.parse(same.content[0].text), { unchanged: true, version: first.version });
  assert.equal(same._meta, undefined, 'an unchanged answer issues no codes');
  await post({ ...receipt(NEXT), status: 'running', review_ref: undefined, commit: undefined });
  const changed = JSON.parse((await tool('panel_data', { since: first.version })).content[0].text);
  assert.notEqual(changed.version, first.version); assert.ok(changed.runs.some((x) => x.run_id === NEXT));
});
