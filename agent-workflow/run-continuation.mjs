// Bounded source identity shared by the runner, Hub and dashboard. No workspace paths.
const run = v => typeof v === 'string' && /^r-\d{8}T\d{6}Z-[a-f0-9]{6}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
export function publicSourceReview(v) {
  if (!v || !run(v.run_id) || !sha(v.base_commit) || !sha(v.commit) || v.base_commit === v.commit
    || v.review_ref !== `refs/heads/review/runs/${v.run_id}`) return undefined;
  return { run_id: v.run_id, base_commit: v.base_commit, commit: v.commit, review_ref: v.review_ref };
}
export function reviewSource(r) {
  if (r?.status !== 'completed') return undefined;
  return publicSourceReview(r) ?? (r.commit === r.source_review?.commit ? publicSourceReview(r.source_review) : undefined);
}
export function verifyContinuationHead(source, actual) {
  if (!publicSourceReview(source) || actual !== source.commit) throw Error('Saved review commit mismatch; preserve the original artifact');
}

export function publicSourcePr(v) {
  if (!v || !run(v.root) || !sha(v.commit) || !/^[\w.-]+\/[\w.-]+$/.test(v.github ?? '')
    || !Number.isSafeInteger(v.pr_number) || v.pr_number < 1 || v.branch !== `review/agents/${v.root}`
    || !Number.isFinite(Date.parse(v.observed_at))) return undefined;
  return { root: v.root, github: v.github, pr_number: v.pr_number, branch: v.branch, commit: v.commit, observed_at: v.observed_at };
}
export function publicReview(v) {
  const source = publicSourcePr(v);
  if (!source || !['open', 'closed', 'merged'].includes(v.state)) return undefined;
  return { ...source, state: v.state, pr_url: `https://github.com/${source.github}/pull/${source.pr_number}` };
}
