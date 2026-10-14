import { ARTIFACT_RUN_ID } from './run-artifact-contract.mjs';

export const PUBLISH_REVIEW = {
  title: 'Publish a saved review', read: false,
  input: { type: 'object', required: ['run_id'], additionalProperties: false,
    properties: { run_id: { type: 'string', pattern: ARTIFACT_RUN_ID.source } } },
  description: 'Publish or retry a completed saved review as a GitHub draft PR in its configured repository. Idempotent: never reruns Pi. Poll get_run.publication until published or blocked. Follow-ups update the same open PR without force-pushing.',
};
export const publicationPending = p => ['waiting_artifact', 'queued', 'publishing', 'retrying'].includes(p?.status);
export function publicPublication(p) {
  if (!p || !['waiting_artifact', 'queued', 'publishing', 'retrying', 'published', 'blocked', 'not_applicable'].includes(p.status)) return undefined;
  const out = { status: p.status };
  for (const k of ['github', 'branch', 'commit', 'conversation_id', 'published_at', 'next_retry_at', 'error', 'pr_url']) {
    if (typeof p[k] === 'string' && p[k].length <= 300) out[k] = p[k];
  }
  if (out.pr_url && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(out.pr_url)) delete out.pr_url;
  if (Number.isSafeInteger(p.pr_number) && p.pr_number > 0) out.pr_number = p.pr_number;
  return out;
}
