import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareArtifact, importArtifact, publishArtifact } from './run-artifact.mjs';
import { ARTIFACT_MAX_BYTES, boundedBytes } from './run-artifact-contract.mjs';

const run_id = 'r-20261013T120047Z-9a2bc4';
const config = { endpoint: 'https://hub.example', token: 'fixture-token-no-authority' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'file'), 'base'); git('add', 'file'); git('commit', '-m', 'base');
  const base_commit = git('rev-parse', 'HEAD');
  const target = path.join(root, 'target'); git('clone', '--no-local', root, target);
  fs.writeFileSync(path.join(root, 'file'), 'review'); git('commit', '-am', 'review');
  const commit = git('rev-parse', 'HEAD'), review_ref = `refs/heads/review/runs/${run_id}`, bundle_ref = `refs/heads/export-${run_id}`;
  git('update-ref', review_ref, commit); git('update-ref', bundle_ref, commit);
  const state = path.join(root, 'state'); fs.mkdirSync(path.join(state, 'quarantine'), { recursive: true });
  const file = path.join(state, 'quarantine', run_id + '.bundle');
  git('bundle', 'create', file, bundle_ref, '^' + base_commit);
  const receipt = { status: 'completed', runner: 'dok', run_id, repo: 'vm', base_commit, commit, review_ref };
  const prepared = prepareArtifact(receipt, { state, repository: root });
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, 'Bearer ' + config.token);
    return String(url).includes('/artifacts/') ? new Response(prepared.bytes, { headers: { 'x-artifact-manifest': JSON.stringify(prepared.manifest) } })
      : Response.json({ ...receipt, artifact: prepared.manifest });
  };
  return { root, git, target, state, file, receipt, prepared, fetchImpl,
    options: { repository: target, repo: 'vm', config, fetchImpl } };
}
test('verified delta round trip preserves checkout, dirty files and existing refs; repeat is idempotent', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.target, 'user-work'), 'preserve');
  const result = await importArtifact(run_id, f.options);
  assert.equal(f.git('-C', f.target, 'rev-parse', result.local_ref), f.receipt.commit);
  assert.equal(f.git('-C', f.target, 'rev-parse', 'HEAD'), f.receipt.base_commit);
  assert.equal(fs.readFileSync(path.join(f.target, 'user-work'), 'utf8'), 'preserve');
  assert.deepEqual(await importArtifact(run_id, f.options), result);
  f.git('-C', f.target, 'update-ref', result.local_ref, f.receipt.base_commit);
  await assert.rejects(importArtifact(run_id, f.options), /Local review ref conflict/);
  assert.equal(f.git('-C', f.target, 'rev-parse', result.local_ref), f.receipt.base_commit);
});
test('producer rejects failed/running runs, missing/symlink/oversized bundles and moved heads', t => {
  const f = fixture(t), opts = { state: f.state, repository: f.root };
  for (const status of ['running', 'failed', 'interrupted']) assert.throws(() => prepareArtifact({ ...f.receipt, status }, opts), /completed/);
  f.git('update-ref', f.receipt.review_ref, f.receipt.base_commit);
  assert.throws(() => prepareArtifact(f.receipt, opts), /ref mismatch/);
  fs.rmSync(f.file); assert.throws(() => prepareArtifact(f.receipt, opts), /ENOENT/);
  fs.symlinkSync(path.join(f.root, 'file'), f.file); assert.throws(() => prepareArtifact(f.receipt, opts));
  fs.rmSync(f.file); fs.writeFileSync(f.file, ''); fs.truncateSync(f.file, ARTIFACT_MAX_BYTES + 1);
  assert.throws(() => prepareArtifact(f.receipt, opts), /size limit/);
});
test('import rejects tampering, wrong identities, missing bases, and invalid ancestry', async t => {
  const f = fixture(t);
  await assert.rejects(importArtifact(run_id, { ...f.options, repo: 'another' }), /Repository/);
  const wrong = async () => Response.json({ ...f.receipt, run_id: 'r-20261013T120047Z-aaaaaa', artifact: f.prepared.manifest });
  await assert.rejects(importArtifact(run_id, { ...f.options, fetchImpl: wrong }));
  const tamper = async (url, init) => {
    if (!String(url).includes('/artifacts/')) return f.fetchImpl(url, init);
    const bytes = Buffer.from(f.prepared.bytes); bytes[bytes.length - 1] ^= 1;
    return new Response(bytes, { headers: { 'x-artifact-manifest': JSON.stringify(f.prepared.manifest) } });
  };
  await assert.rejects(importArtifact(run_id, { ...f.options, fetchImpl: tamper }), /checksum/);
  // A valid bundle can falsely list a base that is not an ancestor; reject after import into staging.
  f.git('checkout', '--orphan', 'unrelated'); f.git('commit', '-am', 'unrelated');
  const unrelated = f.git('rev-parse', 'HEAD');
  f.git('update-ref', f.prepared.manifest.bundle_ref, unrelated);
  const full = path.join(f.root, 'full.bundle'); f.git('bundle', 'create', full, f.prepared.manifest.bundle_ref);
  const original = fs.readFileSync(full), boundary = original.indexOf('\n\n');
  const bytes = Buffer.concat([Buffer.from(`# v2 git bundle\n-${f.receipt.base_commit} base\n${unrelated} ${f.prepared.manifest.bundle_ref}\n\n`), original.subarray(boundary + 2)]);
  const receipt = { ...f.receipt, commit: unrelated };
  const manifest = { ...f.prepared.manifest, commit: unrelated, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const forged = async url => String(url).includes('/artifacts/') ? new Response(bytes, { headers: { 'x-artifact-manifest': JSON.stringify(manifest) } }) : Response.json({ ...receipt, artifact: manifest });
  await assert.rejects(importArtifact(run_id, { ...f.options, fetchImpl: forged }));
  assert.throws(() => f.git('-C', f.target, 'rev-parse', '--verify', `refs/remotes/hub-review/runs/${run_id}`));
  const empty = path.join(f.root, 'empty'); f.git('init', '--bare', empty);
  await assert.rejects(importArtifact(run_id, { ...f.options, repository: empty }), /base commit missing/);
});
test('publisher uses only the authenticated upload route and verifies its acknowledgment', async t => {
  const f = fixture(t);
  const options = { state: f.state, repository: f.root, config, fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/relay/dok-dev/artifacts/' + run_id); assert.equal(init.method, 'PUT'); assert.equal(init.redirect, 'error');
    assert.deepEqual(init.body, f.prepared.bytes); return Response.json(f.prepared.manifest);
  } };
  assert.deepEqual(await publishArtifact(f.receipt, options), f.prepared.manifest);
  await assert.rejects(publishArtifact(f.receipt, { ...options, fetchImpl: async () => new Response('', { status: 503 }) }), /refused/);
});
test('bounded reader refuses declared and actual oversize/truncation', async () => {
  await assert.rejects(boundedBytes(new Response('x').body, ARTIFACT_MAX_BYTES + 1), /size limit/);
  await assert.rejects(boundedBytes(new Response('xx').body, 1), /size mismatch/);
  await assert.rejects(boundedBytes(new Response('x').body, 2), /size mismatch/);
});
