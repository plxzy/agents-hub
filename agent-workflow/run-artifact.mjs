import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { artifactIdentity, artifactManifest, checkBundleHeader, boundedBytes, ARTIFACT_MAX_BYTES, ARTIFACT_RUN_ID } from './run-artifact-contract.mjs';
import { hubConfig, hubRun } from './hub.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Ignore inherited Git overrides and user hooks/config for all artifact operations.
const gitEnv = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (repo, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', '-C', repo, ...args],
  { env: gitEnv, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function prepareArtifact(receipt, { state, repository }) {
  const identity = artifactIdentity(receipt);
  const file = path.join(state, 'quarantine', receipt.run_id + '.bundle');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > ARTIFACT_MAX_BYTES) throw Error('Artifact exceeds size limit');
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  checkBundleHeader(bytes, identity);
  if (git(repository, 'rev-parse', '--verify', identity.review_ref) !== identity.commit) throw Error('Review ref mismatch');
  git(repository, 'bundle', 'verify', file);
  git(repository, 'merge-base', '--is-ancestor', identity.base_commit, identity.commit);
  const manifest = artifactManifest(receipt, { version: 1, ...identity, size: bytes.length, sha256: digest(bytes) });
  return { manifest, bytes };
}

export async function publishArtifact(receipt, { state, repository, config, fetchImpl = fetch }) {
  const { manifest, bytes } = prepareArtifact(receipt, { state, repository });
  const response = await fetchImpl(new URL(`/relay/dok-dev/artifacts/${receipt.run_id}`, config.endpoint), {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000), body: bytes,
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/x-git-bundle', 'x-artifact-manifest': JSON.stringify(manifest) },
  });
  if (!response.ok) throw Error('Artifact publication refused');
  if (JSON.stringify(artifactManifest(receipt, await response.json())) !== JSON.stringify(manifest)) throw Error('Artifact publication mismatch');
  return manifest;
}

/** Import only into a review ref; never checkout, merge, push or change an existing ref. */
export async function importArtifact(runId, { repository, repo, config = hubConfig(), fetchImpl = fetch }) {
  if (!ARTIFACT_RUN_ID.test(runId)) throw Error('Invalid run');
  if (!config) throw Error('This Mac is not linked to the Agents Hub');
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw Error('Invalid Hub endpoint');
  const receipt = await hubRun(runId, { config, fetchImpl });
  const identity = artifactIdentity(receipt);
  if (identity.run_id !== runId || identity.repo !== repo) throw Error('Repository or run mismatch');
  const manifest = artifactManifest(receipt, receipt.artifact);
  // A delta bundle requires the recorded base, usually available after git fetch origin.
  try { git(repository, 'cat-file', '-e', `${identity.base_commit}^{commit}`); }
  catch { throw Error('Recorded base commit missing; fetch the repository origin before importing'); }
  const response = await fetchImpl(new URL(`/relay/mac/artifacts/${runId}`, endpoint), {
    redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: 'Bearer ' + config.token },
  });
  if (!response.ok) throw Error('Artifact download unavailable');
  const download = artifactManifest(receipt, JSON.parse(response.headers.get('x-artifact-manifest') ?? 'null'));
  if (JSON.stringify(download) !== JSON.stringify(manifest)) throw Error('Artifact changed since receipt read');
  const bytes = await boundedBytes(response.body, manifest.size);
  if (digest(bytes) !== manifest.sha256) throw Error('Artifact checksum mismatch');
  checkBundleHeader(bytes, identity);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifact-'));
  try {
    const bundle = path.join(tmp, 'review.bundle'), staging = path.join(tmp, 'verify.git');
    fs.writeFileSync(bundle, bytes, { mode: 0o600 });
    git(tmp, 'init', '--bare', staging);
    const objects = git(repository, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
    if (/[\r\n]/.test(objects)) throw Error('Invalid repository path');
    fs.writeFileSync(path.join(staging, 'objects/info/alternates'), objects + '\n');
    git(staging, 'bundle', 'verify', bundle);
    git(staging, '-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', bundle, `${identity.bundle_ref}:refs/heads/verified`);
    if (git(staging, 'rev-parse', 'refs/heads/verified') !== identity.commit) throw Error('Artifact head mismatch');
    git(staging, 'merge-base', '--is-ancestor', identity.base_commit, identity.commit);
    const ref = `refs/remotes/hub-review/runs/${runId}`;
    let existing;
    try { existing = git(repository, 'rev-parse', '--verify', ref); } catch { /* New ref. */ }
    if (existing && existing !== identity.commit) throw Error('Local review ref conflict');
    if (!existing) {
      git(repository, '-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', staging, identity.commit);
      // Compare-and-create: a concurrent importer cannot replace an existing ref.
      try { git(repository, 'update-ref', ref, identity.commit, '0'.repeat(40)); }
      catch { if (git(repository, 'rev-parse', '--verify', ref) !== identity.commit) throw Error('Local review ref conflict'); }
    }
    return { ...manifest, local_ref: ref };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
