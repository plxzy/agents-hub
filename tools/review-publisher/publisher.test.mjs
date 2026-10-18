import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { git, prepareBase, prepareReview, cleanupMergedReview, publishJob, verifiedRepository, reviewBody, reviewTitle } from './publisher.mjs';
import { githubClient, PublicationError } from './github.mjs';
import { serializeByKey } from './server.mjs';

const RUN = 'r-20261014T020744Z-71aa46', NEXT = 'r-20261014T030744Z-71aa47';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const config = { repositories: { vm: { github: 'owner/vm', base: 'main', repository: '/unused' } } };
const job = () => ({ run_id: RUN, root: RUN, github: 'owner/vm', base: 'main', branch: `review/agents/${RUN}`,
  receipt: { run_id: RUN, repo: 'vm', commit: B, base_commit: A, title: 'Test patch', output: 'Tests: 2 passed' } });
function fake() {
  let head = null, pr = null, creates = 0, pushes = 0, failCreate = false;
  const gh = { token: async () => 'test-token', request: async (url, options = {}) => {
    if (url.includes('/git/ref/')) return head ? { object: { sha: head } } : null;
    if (url.includes('/pulls?')) return pr ? [structuredClone(pr)] : [];
    if (url.endsWith('/pulls') && options.method === 'POST') {
      creates++; pr = { number: 17, html_url: 'https://github.com/owner/vm/pull/17', state: 'open', draft: true,
        title: options.body.title, body: options.body.body, head: { ref: job().branch, repo: { full_name: 'owner/vm' }, sha: head }, base: { ref: 'main' } };
      if (failCreate) { failCreate = false; throw new PublicationError('unavailable', true); }
      return structuredClone(pr);
    }
    if (url.endsWith('/pulls/17')) {
      if (options.method === 'PATCH') pr.body = options.body.body;
      return { ...structuredClone(pr), head: { ...pr.head, sha: head } };
    }
    throw Error('Unexpected API');
  } };
  const io = { verify: async (_t, _j, _b, fn) => fn('/staging'), gitImpl: async (_repo, args) => {
    if (args[0] === 'push') { pushes++; head = args.at(-1).split(':')[0]; }
  } };
  return { gh, io, get creates() { return creates; }, get pushes() { return pushes; }, get pr() { return pr; },
    set head(v) { head = v; }, set failCreate(v) { failCreate = v; } };
}
test('a lost PR response reconciles without duplicate push or creation', async () => {
  const f = fake(); f.failCreate = true;
  await assert.rejects(publishJob(config, f.gh, job(), new Uint8Array(), f.io), /unavailable/);
  const result = await publishJob(config, f.gh, job(), new Uint8Array(), f.io);
  assert.equal(result.pr_number, 17); assert.equal(f.creates, 1); assert.equal(f.pushes, 1);
});
test('follow-ups reuse the PR, preserve human description edits and refuse external changes', async () => {
  const f = fake(); await publishJob(config, f.gh, job(), new Uint8Array(), f.io);
  f.pr.body += '\nHuman review context'; f.pr.draft = false;
  const next = job(); next.run_id = NEXT; next.receipt = { ...next.receipt, run_id: NEXT, commit: C, base_commit: B };
  next.thread = { repo: 'vm', branch: next.branch, commit_sha: B, pr_number: 17 };
  await publishJob(config, f.gh, next, new Uint8Array(), f.io);
  assert.equal(f.creates, 1); assert.equal(f.pushes, 2); assert.match(f.pr.body, /Human review context/); assert.equal(f.pr.draft, false);
  f.head = A;
  await assert.rejects(publishJob(config, f.gh, next, new Uint8Array(), f.io), /conflict/);
});
test('closed PRs and repository or branch substitution stop before pushing', async () => {
  const f = fake(); await publishJob(config, f.gh, job(), new Uint8Array(), f.io);
  f.pr.state = 'closed';
  const next = job(); next.receipt.commit = C;
  await assert.rejects(publishJob(config, f.gh, next, new Uint8Array(), f.io), /conflict/);
  await assert.rejects(publishJob(config, f.gh, { ...job(), github: 'other/repo' }, new Uint8Array(), f.io), /rejected/);
  await assert.rejects(publishJob(config, f.gh, { ...job(), branch: 'main' }, new Uint8Array(), f.io), /invalid_artifact/);
  assert.equal(f.pushes, 1);
});
test('a stale PR response after a confirmed push retries without another push', async () => {
  const f = fake(); await publishJob(config, f.gh, job(), new Uint8Array(), f.io);
  const next = job(); next.run_id = NEXT;
  next.receipt = { ...next.receipt, run_id: NEXT, commit: C, base_commit: B };
  next.thread = { repo: 'vm', branch: next.branch, commit_sha: B, pr_number: 17 };
  const request = f.gh.request; let stale = true;
  f.gh.request = async (url, options) => {
    const result = await request(url, options);
    return stale && url.endsWith('/pulls/17') ? { ...result, head: { ...result.head, sha: B } } : result;
  };
  await assert.rejects(publishJob(config, f.gh, next, new Uint8Array(), f.io),
    e => e.code === 'unavailable' && e.retry === true);
  stale = false;
  assert.equal((await publishJob(config, f.gh, next, new Uint8Array(), f.io)).status, 'published');
  assert.equal(f.pushes, 2); assert.equal(f.creates, 1);
});
test('real Git bundle verification rejects corruption and preserves exact identity', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-test-')); t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await git(tmp, ['init', '-b', 'main']);
  const commit = async text => { await fs.writeFile(path.join(tmp, 'file'), text); await git(tmp, ['add', 'file']);
    await git(tmp, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', text]); return git(tmp, ['rev-parse', 'HEAD']); };
  const base = await commit('base'), head = await commit('patch'), bundleRef = `refs/heads/export-${RUN}`;
  await git(tmp, ['update-ref', bundleRef, head]);
  await git(tmp, ['bundle', 'create', 'review.bundle', bundleRef, '^' + base]);
  const bytes = await fs.readFile(path.join(tmp, 'review.bundle'));
  const receipt = { ...job().receipt, runner: 'dok', status: 'completed', base_commit: base, commit: head, review_ref: `refs/heads/review/runs/${RUN}` };
  const manifest = { version: 1, run_id: RUN, repo: 'vm', commit: head, base_commit: base, review_ref: receipt.review_ref,
    bundle_ref: bundleRef, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const value = { ...job(), receipt, manifest };
  assert.equal(await verifiedRepository({ repository: tmp }, value, bytes, repo => git(repo, ['rev-parse', 'refs/heads/verified'])), head);
  const bad = Buffer.from(bytes); bad[bad.length - 1] ^= 1;
  await assert.rejects(verifiedRepository({ repository: tmp }, value, bad, () => assert.fail()), /invalid_artifact/);
  await assert.rejects(verifiedRepository({ repository: tmp }, { ...value, manifest: { ...manifest, repo: 'wrong' } }, bytes, () => assert.fail()), /mismatch/);
});
test('base preparation is pinned and refuses network failure instead of using main', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-base-')); t.after(() => fs.rm(state, { recursive: true, force: true }));
  let value = null, fetches = 0;
  const gitImpl = async (_repo, args) => { if (args[0] === 'fetch') { fetches++; value = A; return ''; } if (!value) throw Error('missing'); return value; };
  const c = { ...config, state }, gh = { token: async () => 'test-token' };
  const a = await prepareBase(c, gh, { repo: 'vm', run_id: RUN }, gitImpl);
  assert.equal(a.commit, A); assert.deepEqual(await prepareBase(c, gh, { repo: 'vm', run_id: RUN }, gitImpl), a); assert.equal(fetches, 1);
  await assert.rejects(prepareBase(c, gh, { repo: 'vm', run_id: NEXT }, async () => { throw Error('offline'); }), /offline/);
});
test('App tokens are scoped, cached, renewed and never appear in public errors', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-auth-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.pem'); await fs.writeFile(file, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  let calls = 0, bodies = [];
  const gh = githubClient({ app_id: 1, installation_id: 2, private_key_file: file }, async (_url, options) => {
    calls++; bodies.push(JSON.parse(options.body)); return Response.json({ token: 'test-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
  });
  await gh.token('owner/vm'); await gh.token('owner/vm'); assert.equal(calls, 1);
  assert.deepEqual(bodies[0].repositories, ['vm']); assert.equal(bodies[0].permissions.pull_requests, 'write');
  await gh.token('owner/vm', { readOnly: true }); assert.deepEqual(bodies[1].permissions, { contents: 'read' });
  gh.invalidate(); await gh.token('owner/vm'); assert.equal(calls, 3);
});
test('per-repository operations serialize, while different repositories can progress', async () => {
  const serial = serializeByKey(), events = []; let release;
  const first = serial('vm', async () => { events.push('first'); await new Promise(r => { release = r; }); events.push('done'); });
  await Promise.resolve();
  const second = serial('vm', async () => events.push('second'));
  await serial('other', async () => events.push('other')); release(); await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other', 'done', 'second']);
});
test('PR report omits prompts and obvious private material', () => {
  const j = job(); j.receipt.task = 'private task'; j.receipt.output = '17 tests passed\n/home/agent/private\nBearer secret\nhttps://host/path?token=secret';
  const body = reviewBody(j); assert.match(body, /17 tests passed/); assert.doesNotMatch(body, /private task|\/home|Bearer|token=/);
});
test('a run linked to an issue references it in the new PR body', () => {
  const j = job(); assert.doesNotMatch(reviewBody(j), /Refs #/);
  j.receipt.issue_number = 806; assert.match(reviewBody(j), /\n\nRefs #806\n\n/);
  j.receipt.issue_number = '806 closes #1'; assert.doesNotMatch(reviewBody(j), /Refs #/);
});

test('the PR title is the agent summary line, not the task echo', () => {
  // Real shape of run r-20261018T232928Z-1ba8d0, whose draft PR inherited the whole task instead.
  const j = job();
  j.receipt.title = "Decide what's next in this repo and do it.";
  j.receipt.output = 'Picked **#36: receipt identity verification**. The existing reconciliation flow was largely implemented.\n\n### Changes\n- require the success response to prove that exact digest';
  assert.equal(reviewTitle(j.receipt), 'Picked **#36: receipt identity verification**. The existing reconciliation flow was largely implemented.');
  j.receipt.output = "Decide what's next in this repo and do it.\nDetails follow.";
  assert.equal(reviewTitle(j.receipt), "Decide what's next in this repo and do it.", 'long fallback cap stands');
  j.receipt.output = `Fixed the collector once flow. ${'x'.repeat(96)}`;
  const title = reviewTitle(j.receipt);
  assert.equal(title.length, 120); assert.ok(title.endsWith('…'));
  j.receipt.output = `A whole paragraph without breaks. ${'x'.repeat(500)}`;
  assert.equal(reviewTitle(j.receipt), "Decide what's next in this repo and do it.", 'a paragraph without line breaks is not a title');
  j.receipt.output = 'Fixed tests/unit/test_collector_runner.py:101 expectation\n\n### Verification\n`node --test` passed\n\nExcluded paths remain.';
  assert.equal(reviewTitle(j.receipt), 'Fixed tests/unit/test_collector_runner.py:101 expectation');
  j.receipt.output = '## Findings\nTwo findings in `docs/ci.md`, both fixed in place.';
  assert.equal(reviewTitle(j.receipt), 'Two findings in `docs/ci.md`, both fixed in place.', 'a style heading yields to the prose below');
  j.receipt.output = 'postponed details\n\n## Collected reports by direct times when available\n\n- changes';
  assert.equal(reviewTitle(j.receipt), "Decide what's next in this repo and do it.", 'a one-word lead is not a summary');
  j.receipt.output = 'reply with a credential pattern\n/home/agent/.pi\nBearer tok';
  assert.equal(reviewTitle(j.receipt), "Decide what's next in this repo and do it.", 'private material cannot title a PR');
  j.receipt.output = '## Agent-reported changes\n - things\nNo usable plain line.';
  j.receipt.title = undefined;
  assert.equal(reviewTitle(j.receipt), 'Agents Hub review');
});

test('publishJob sends the summary-line title once, with the agent report in the body', async () => {
  const f = fake(); const j = job();
  j.receipt.title = 'Long task first line that used to become the draft title';
  j.receipt.output = 'Selected receipt identity verification for the collector.\n\n### Changes\n- collector/api.py requires digest proof';
  const result = await publishJob(config, f.gh, j, new Uint8Array(), f.io);
  assert.equal(result.status, 'published');
  assert.equal(f.pr.title, 'Selected receipt identity verification for the collector.');
  assert.match(f.pr.body, /## Agent-reported changes and validation/);
  assert.match(f.pr.body, /collector\/api\.py requires digest proof/);
  assert.doesNotMatch(f.pr.body, /Long task first line/);
});

test('publication adopts a trusted pinned reviewer head and blocks later concurrent changes', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-review-')); t.after(() => fs.rm(state, { recursive: true, force: true }));
  const f = fake(); await publishJob(config, f.gh, job(), new Uint8Array(), f.io);
  const human = 'd'.repeat(40), next = job(); next.run_id = NEXT;
  next.receipt = { ...next.receipt, run_id: NEXT, commit: C, base_commit: human,
    source_pr: { root: RUN, github: 'owner/vm', pr_number: 17, branch: next.branch, commit: human, observed_at: '2026-10-14T12:00:00Z' } };
  next.thread = { repo: 'vm', branch: next.branch, commit_sha: B, pr_number: 17 };
  await fs.mkdir(path.join(state, 'bases'));
  await fs.writeFile(path.join(state, 'bases', NEXT + '.json'), JSON.stringify({ repo: 'vm', commit: human, source_pr: next.receipt.source_pr }));
  f.head = human;
  await publishJob({ ...config, state }, f.gh, next, new Uint8Array(), f.io);
  assert.equal(f.creates, 1); assert.equal(f.pushes, 2);
  f.head = A;
  await assert.rejects(publishJob({ ...config, state }, f.gh, next, new Uint8Array(), f.io), /conflict/);
  assert.equal(f.pushes, 2);
});

test('a retry after merge and branch deletion never recreates the branch', async () => {
  const f = fake(); await publishJob(config, f.gh, job(), new Uint8Array(), f.io);
  f.pr.state = 'closed'; f.pr.merged_at = '2026-10-14T12:00:00Z';
  const real = f.gh.request;
  f.gh.request = async (url, options) => {
    if (url.endsWith('/pulls/17')) return { ...f.pr, head: { ...f.pr.head, sha: B } };
    return real(url, options);
  };
  f.head = null;
  const j = job(); j.thread = { repo: 'vm', branch: j.branch, commit_sha: B, pr_number: 17 };
  assert.equal((await publishJob(config, f.gh, j, new Uint8Array(), f.io)).status, 'published');
  assert.equal(f.pushes, 1);
});

test('PR preparation pins a fetched reviewer head and rejects closed PRs', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-pr-')); t.after(() => fs.rm(state, { recursive: true, force: true }));
  const f = fake(); await publishJob(config, f.gh, job(), new Uint8Array(), f.io); f.head = C;
  let ref, fetches = 0;
  const gitImpl = async (_repo, args) => {
    if (args[0] === 'fetch') { ref = C; fetches++; }
    if (args[0] === 'rev-parse') { if (!ref) throw Error('missing'); return ref; }
  };
  const thread = { root: RUN, repo: 'vm', github: 'owner/vm', branch: job().branch, base: 'main', commit_sha: B, pr_number: 17 };
  const value = await prepareReview({ ...config, state }, f.gh, { repo: 'vm', run_id: NEXT }, thread, gitImpl);
  assert.equal(value.source_pr.commit, C); assert.equal(value.source_pr.root, RUN);
  assert.deepEqual(await prepareReview({ ...config, state }, f.gh, { repo: 'vm', run_id: NEXT }, thread, gitImpl), value);
  assert.equal(fetches, 1);
  f.pr.state = 'closed';
  await assert.rejects(prepareReview({ ...config, state }, f.gh, { repo: 'vm', run_id: NEXT }, thread, gitImpl), /conflict/);
});
test('remote cleanup uses a compare-and-delete lease and preserves changed tips', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-pr-')); t.after(() => fs.rm(state, { recursive: true, force: true }));
  const f = fake(); await publishJob(config, f.gh, job(), new Uint8Array(), f.io);
  f.pr.state = 'closed'; f.pr.merged_at = '2026-10-14T12:00:00Z'; f.pr.merge_commit_sha = C;
  const request = f.gh.request; f.gh.request = (url, options) => url.includes('state=open') ? [] : request(url, options);
  const thread = { root: RUN, repo: 'vm', github: 'owner/vm', branch: job().branch, base: 'main', pr_number: 17 };
  const calls = [], gitImpl = async (_repo, args) => { calls.push(args); };
  assert.equal((await cleanupMergedReview({ ...config, state }, f.gh, thread, gitImpl)).status, 'disabled');
  assert.equal((await cleanupMergedReview({ ...config, state, cleanupMergedBranches: true }, f.gh, thread, gitImpl)).status, 'deleted');
  assert.ok(calls.some(args => args.includes(`--force-with-lease=refs/heads/${thread.branch}:${B}`)));
  f.head = A;
  // Keep the PR's final merge head at B while the branch has changed.
  f.gh.request = (url, options) => url.endsWith('/pulls/17') ? { ...f.pr, head: { ...f.pr.head, sha: B } } : request(url, options);
  assert.equal((await cleanupMergedReview({ ...config, state, cleanupMergedBranches: true }, f.gh, thread, gitImpl)).status, 'preserved');
});
