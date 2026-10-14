import { artifactIdentity, artifactManifest, checkBundleHeader, boundedBytes } from '../../agent-workflow/run-artifact-contract.mjs';

const key = r => `review-v1/${r.run_id}.bundle`;
export async function readArtifact(env, receipt) {
  try { artifactIdentity(receipt); } catch { return undefined; }
  if (!env.RUN_ARTIFACTS) return undefined;
  const object = await env.RUN_ARTIFACTS.head(key(receipt));
  return object ? artifactManifest(receipt, JSON.parse(object.customMetadata.manifest)) : undefined;
}
export async function uploadArtifact(request, env, receipt) {
  if (!env.RUN_ARTIFACTS) return Response.json({ error: 'Artifact storage unavailable' }, { status: 503 });
  try {
    const raw = request.headers.get('x-artifact-manifest') ?? '';
    if (raw.length > 2048) throw Error('Invalid artifact manifest');
    const manifest = artifactManifest(receipt, JSON.parse(raw));
    const bytes = await boundedBytes(request.body, manifest.size);
    checkBundleHeader(bytes, manifest);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') !== manifest.sha256) throw Error('Artifact checksum mismatch');
    const object = await env.RUN_ARTIFACTS.put(key(receipt), bytes, {
      onlyIf: { etagDoesNotMatch: '*' }, sha256: manifest.sha256,
      customMetadata: { manifest: JSON.stringify(manifest) }, httpMetadata: { contentType: 'application/x-git-bundle' },
    });
    if (!object && JSON.stringify(await readArtifact(env, receipt)) !== JSON.stringify(manifest)) {
      return Response.json({ error: 'Immutable artifact conflict' }, { status: 409 });
    }
    return Response.json(manifest, { headers: { 'cache-control': 'no-store' } });
  } catch { return Response.json({ error: 'Artifact refused' }, { status: 400 }); }
}
export async function downloadArtifact(env, receipt) {
  try { artifactIdentity(receipt); } catch { return Response.json({ error: 'Run has no completed review artifact' }, { status: 409 }); }
  if (!env.RUN_ARTIFACTS) return Response.json({ error: 'Artifact storage unavailable' }, { status: 503 });
  const object = await env.RUN_ARTIFACTS.get(key(receipt));
  if (!object) return Response.json({ error: 'Artifact not published' }, { status: 404 });
  const manifest = artifactManifest(receipt, JSON.parse(object.customMetadata.manifest));
  return new Response(object.body, { headers: { 'content-type': 'application/x-git-bundle',
    'content-length': String(manifest.size), 'x-artifact-manifest': JSON.stringify(manifest),
    'cache-control': 'no-store', 'content-disposition': `attachment; filename="${receipt.run_id}.bundle"` } });
}
