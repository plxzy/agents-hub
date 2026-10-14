import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { uploadArtifact, downloadArtifact, readArtifact } from '../src/run-artifacts.mjs';

const RUN = 'r-20261013T120047Z-9a2bc4';
const receipt = { run_id: RUN, runner: 'dok', status: 'completed', repo: 'vm',
  base_commit: 'a'.repeat(40), commit: 'b'.repeat(40), review_ref: `refs/heads/review/runs/${RUN}` };
const bundle = new TextEncoder().encode(`# v2 git bundle\n-${receipt.base_commit} base\n${receipt.commit} refs/heads/export-${RUN}\n\nbody`);
const manifest = { version: 1, run_id: RUN, repo: 'vm', commit: receipt.commit, base_commit: receipt.base_commit,
  review_ref: receipt.review_ref, bundle_ref: `refs/heads/export-${RUN}`, size: bundle.length,
  sha256: createHash('sha256').update(bundle).digest('hex') };
function bucket() {
  const objects = new Map();
  return { objects,
    async head(key) { const v = objects.get(key); return v ? { customMetadata: v.metadata, size: v.body.length } : null; },
    async put(key, body, options) { if (objects.has(key) && options.onlyIf) return null; objects.set(key, { body: new Uint8Array(body), metadata: options.customMetadata }); return {}; },
    async get(key) { const v = objects.get(key); return v ? { body: new Response(v.body).body, customMetadata: v.metadata, size: v.body.length } : null; } };
}
test('R2 artifact upload is authenticated by the receipt, immutable, and downloadable', async () => {
  const RUN_ARTIFACTS = bucket(), env = { RUN_ARTIFACTS };
  const req = new Request('https://hub/relay/dok-dev/artifacts/' + RUN, { method: 'PUT', body: bundle,
    headers: { 'x-artifact-manifest': JSON.stringify(manifest) } });
  assert.deepEqual(await (await uploadArtifact(req, env, receipt)).json(), manifest);
  assert.deepEqual(await readArtifact(env, receipt), manifest);
  const conflict = await uploadArtifact(new Request(req.url, { method: 'PUT', body: new Uint8Array([...bundle, 1]), headers: { 'x-artifact-manifest': JSON.stringify(manifest) } }), env, receipt);
  assert.equal(conflict.status, 400);
  const response = await downloadArtifact(env, receipt);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(bundle.length));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bundle);
});
test('R2 artifact routes fail closed without storage or with an incomplete run', async () => {
  assert.equal((await uploadArtifact(new Request('https://hub', { method: 'PUT', body: bundle }), {}, receipt)).status, 503);
  assert.equal((await downloadArtifact({}, { ...receipt, status: 'failed' })).status, 409);
});
test('R2 metadata tampering is refused', async () => {
  const RUN_ARTIFACTS = bucket(), env = { RUN_ARTIFACTS };
  const bad = { ...manifest, sha256: 'c'.repeat(64) };
  const response = await uploadArtifact(new Request('https://hub', { method: 'PUT', body: bundle,
    headers: { 'x-artifact-manifest': JSON.stringify(bad) } }), env, receipt);
  assert.equal(response.status, 400); assert.equal(await readArtifact(env, receipt), undefined);
});
