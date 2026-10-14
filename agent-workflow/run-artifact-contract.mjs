// Shared browser/Worker/Node contract. No paths, credentials or checkpoints in artifacts.
export const ARTIFACT_MAX_BYTES = 16 * 1024 ** 2;
export const ARTIFACT_RUN_ID = /^r-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
export function artifactIdentity(r) {
  if (!r || r.status !== 'completed' || r.runner !== 'dok' || !ARTIFACT_RUN_ID.test(r.run_id)
    || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(r.repo ?? '') || !sha(r.commit) || !sha(r.base_commit)
    || r.commit === r.base_commit || r.review_ref !== `refs/heads/review/runs/${r.run_id}`) throw Error('Run has no completed review artifact');
  return { run_id: r.run_id, repo: r.repo, commit: r.commit, base_commit: r.base_commit,
    review_ref: r.review_ref, bundle_ref: `refs/heads/export-${r.run_id}` };
}
export function artifactManifest(r, value) {
  const identity = artifactIdentity(r);
  if (!value || value.version !== 1 || Object.entries(identity).some(([k, v]) => value[k] !== v)
    || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '') || !Number.isSafeInteger(value.size)
    || value.size < 1 || value.size > ARTIFACT_MAX_BYTES) throw Error('Artifact manifest mismatch');
  return { version: 1, ...identity, size: value.size, sha256: value.sha256 };
}
// Only accept our incremental v2 bundle: one base prerequisite, one exported head.
export function checkBundleHeader(bytes, identity) {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 16384)));
  const end = text.indexOf('\n\n');
  if (end < 0) throw Error('Invalid bundle header');
  const lines = text.slice(0, end).split('\n');
  if (lines.length !== 3 || lines[0] !== '# v2 git bundle'
    || !lines[1].startsWith(`-${identity.base_commit} `)
    || lines[2] !== `${identity.commit} ${identity.bundle_ref}`) throw Error('Bundle identity mismatch');
}
export async function boundedBytes(body, size) {
  if (!body || !Number.isSafeInteger(size) || size < 1 || size > ARTIFACT_MAX_BYTES) throw Error('Artifact exceeds size limit');
  const reader = body.getReader(), result = new Uint8Array(size); let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (offset + value.length > size) throw Error('Artifact size mismatch');
      result.set(value, offset); offset += value.length;
    }
    if (offset !== size) throw Error('Artifact size mismatch');
    return result;
  } finally { await reader.cancel(); reader.releaseLock(); }
}
