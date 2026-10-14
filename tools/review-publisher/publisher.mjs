import { publicSourcePr } from '../../agent-workflow/run-continuation.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { artifactManifest, checkBundleHeader, ARTIFACT_RUN_ID } from '../../agent-workflow/run-artifact-contract.mjs';
import { PublicationError } from './github.mjs';

const exec = promisify(execFile);
export async function git(repo, args, token) {
  const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    ...(token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64') } : {}) };
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never',
      '-c', 'http.followRedirects=false', '-C', repo, ...args], { env, timeout: 90000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    // Classify privately; Git stderr can contain URLs and must never leave this process.
    const message = String(e.stderr ?? '');
    if (token && /Authentication failed|could not read Username|Invalid username or token|401/.test(message)) throw new PublicationError('authentication');
    if (token && /non-fast-forward|fetch first|stale info|cannot lock ref/.test(message)) throw new PublicationError('conflict');
    if (token && /permission|denied|protected branch|GH0\d+|403|refusing to allow/i.test(message)) throw new PublicationError('rejected');
    throw new PublicationError(token ? 'unavailable' : 'invalid_artifact', !!token);
  }
}
export function targetFor(config, repo, github) {
  const target = Object.hasOwn(config.repositories, repo ?? '') ? config.repositories[repo] : null;
  if (!target || !/^[\w.-]+\/[\w.-]+$/.test(target.github) || target.base !== 'main' || github && target.github !== github) throw new PublicationError('rejected');
  return target;
}
export async function prepareBase(config, github, { repo, run_id }, gitImpl = git) {
  if (!ARTIFACT_RUN_ID.test(run_id ?? '')) throw new PublicationError('rejected');
  const target = targetFor(config, repo), ref = `refs/heads/base/runs/${run_id}`;
  // Same preparation request always resolves to the same commit, including after a restart.
  const record = path.join(config.state, 'bases', run_id + '.json');
  try {
    const saved = JSON.parse(await fs.readFile(record, 'utf8'));
    if (saved.repo !== repo || saved.ref !== ref || await gitImpl(target.repository, ['rev-parse', ref]) !== saved.commit) throw new PublicationError('conflict');
    return saved;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // A ref without its observation record cannot prove a fresh fetch after a crash.
  let commit;
  try { commit = await gitImpl(target.repository, ['rev-parse', '--verify', ref]); } catch { /* New identity. */ }
  if (commit) throw new PublicationError('conflict');
  if (!commit) {
    const token = await github.token(target.github, { readOnly: true });
    await gitImpl(target.repository, ['fetch', '--no-tags', '--no-write-fetch-head', `https://github.com/${target.github}.git`, `refs/heads/${target.base}:${ref}`], token);
    commit = await gitImpl(target.repository, ['rev-parse', ref]);
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new PublicationError('invalid_artifact');
  const value = { repo, run_id, ref, commit, observed_at: new Date().toISOString() };
  await fs.mkdir(path.dirname(record), { recursive: true, mode: 0o700 });
  await fs.writeFile(record + '.tmp', JSON.stringify(value), { mode: 0o600, flush: true });
  await fs.rename(record + '.tmp', record);
  return value;
}
export async function observeReview(config, github, thread) {
  targetFor(config, thread.repo, thread.github);
  const token = await github.token(thread.github, { readOnly: true, reviewRead: true });
  const pr = await github.request(`/repos/${thread.github}/pulls/${thread.pr_number}`, { token });
  if (pr.head?.ref !== thread.branch || pr.head?.repo?.full_name !== thread.github || pr.base?.ref !== thread.base)
    throw new PublicationError('conflict');
  return { root: thread.root, github: thread.github, pr_number: thread.pr_number, branch: thread.branch,
    commit: pr.head.sha, observed_at: new Date().toISOString(), state: pr.merged_at ? 'merged' : pr.state };
}
export async function prepareReview(config, github, args, thread, gitImpl = git) {
  const { repo, run_id } = args;
  if (!ARTIFACT_RUN_ID.test(run_id ?? '') || repo !== thread.repo) throw new PublicationError('rejected');
  const target = targetFor(config, repo, thread.github);
  const observation = await observeReview(config, github, thread);
  if (observation.state !== 'open') throw new PublicationError('conflict');
  const ref = `refs/heads/base/runs/${run_id}`, record = path.join(config.state, 'bases', run_id + '.json');
  try {
    const saved = JSON.parse(await fs.readFile(record, 'utf8'));
    if (saved.repo !== repo || saved.source_pr?.root !== thread.root || saved.ref !== ref
      || await gitImpl(target.repository, ['rev-parse', ref]) !== saved.commit) throw new PublicationError('conflict');
    return saved;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Never replace an orphaned ref or use a cached head when the network is unavailable.
  let existing;
  try { existing = await gitImpl(target.repository, ['rev-parse', '--verify', ref]); } catch { /* new run */ }
  if (existing) throw new PublicationError('conflict');
  const token = await github.token(thread.github, { readOnly: true, reviewRead: true });
  await gitImpl(target.repository, ['fetch', '--no-tags', '--no-write-fetch-head', `https://github.com/${thread.github}.git`, `refs/heads/${thread.branch}:${ref}`], token);
  const commit = await gitImpl(target.repository, ['rev-parse', ref]);
  if (commit !== observation.commit) throw new PublicationError('conflict');
  await gitImpl(target.repository, ['merge-base', '--is-ancestor', thread.commit_sha, commit]);
  const source_pr = publicSourcePr(observation);
  if (!source_pr) throw new PublicationError('conflict');
  const value = { repo, run_id, ref, commit, observed_at: observation.observed_at, source_pr };
  await fs.mkdir(path.dirname(record), { recursive: true, mode: 0o700 });
  await fs.writeFile(record + '.tmp', JSON.stringify(value), { mode: 0o600, flush: true });
  await fs.rename(record + '.tmp', record);
  return value;
}

export async function verifiedRepository(target, job, bytes, fn) {
  const manifest = artifactManifest(job.receipt, job.manifest);
  if (bytes.length !== manifest.size || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new PublicationError('invalid_artifact');
  checkBundleHeader(bytes, manifest);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-publish-'));
  try {
    const staging = path.join(tmp, 'verify.git'), bundle = path.join(tmp, 'review.bundle');
    await git(tmp, ['init', '--bare', staging]);
    const objects = await git(target.repository, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
    if (/[\r\n]/.test(objects)) throw new PublicationError('invalid_artifact');
    await fs.writeFile(path.join(staging, 'objects/info/alternates'), objects + '\n');
    await fs.writeFile(bundle, bytes, { mode: 0o600 });
    await git(staging, ['bundle', 'verify', bundle]);
    await git(staging, ['-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', bundle, `${manifest.bundle_ref}:refs/heads/verified`]);
    if (await git(staging, ['rev-parse', 'refs/heads/verified']) !== manifest.commit) throw new PublicationError('invalid_artifact');
    await git(staging, ['merge-base', '--is-ancestor', manifest.base_commit, manifest.commit]);
    return await fn(staging);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
const marker = root => `<!-- agents-hub-review:${root} -->`;
export function reviewBody(job) {
  const r = job.receipt;
  // Keep full prompts, private paths and memory out of GitHub descriptions. The run's output is agent-reported evidence.
  const output = String(r.output ?? '').split('\n').filter(line => !/(Bearer\s|gh[opusr]_|github_pat_|sk-|PRIVATE KEY|\/home\/|\/Users\/|https?:\/\/[^\s]*[?])/.test(line)).join('\n').slice(0, 12000);
  return `${marker(job.root)}\n\nSaved Agents Hub review from ${r.run_id}.\n\nOriginal saved head: ${r.commit}\nOriginal tested base: ${r.base_commit}\n\n## Agent-reported changes and validation\n\n${output || 'See the saved run for its report.'}\n\nPublication preserves the tested commit. It does not establish current-main integration or passing GitHub checks.`;
}
export async function publishJob(config, github, job, bytes, { verify = verifiedRepository, gitImpl = git } = {}) {
  if (!ARTIFACT_RUN_ID.test(job.root ?? '') || job.run_id !== job.receipt?.run_id || job.branch !== `review/agents/${job.root}`) throw new PublicationError('invalid_artifact');
  const target = targetFor(config, job.receipt.repo, job.github);
  if (target.base !== job.base) throw new PublicationError('rejected');
  return verify(target, job, bytes, async staging => {
    const token = await github.token(job.github), prefix = `/repos/${job.github}`;
    const api = (route, options = {}) => github.request(prefix + route, { token, ...options });
    const head = job.receipt.commit;
    let expected = job.thread?.commit_sha;
    if (job.receipt.source_pr) {
      const source = publicSourcePr(job.receipt.source_pr);
      const saved = JSON.parse(await fs.readFile(path.join(config.state, 'bases', job.run_id + '.json'), 'utf8'));
      if (!source || !job.thread || source.root !== job.root || source.github !== job.github
        || source.pr_number !== job.thread.pr_number || saved.repo !== job.receipt.repo || saved.commit !== source.commit
        || JSON.stringify(saved.source_pr) !== JSON.stringify(source) || job.receipt.base_commit !== source.commit)
        throw new PublicationError('invalid_artifact');
      expected = source.commit;
    }
    if (job.thread && (job.thread.repo !== job.receipt.repo || job.thread.branch !== job.branch)) throw new PublicationError('conflict');
    let pr = job.thread ? await api(`/pulls/${job.thread.pr_number}`) : null;
    if (!pr) {
      const prs = await api(`/pulls?state=all&head=${encodeURIComponent(job.github.split('/')[0] + ':' + job.branch)}&per_page=100`);
      if (prs.length > 1) throw new PublicationError('conflict');
      pr = prs[0];
    }
    if (pr && (pr.head.ref !== job.branch || pr.head.repo?.full_name !== job.github || pr.base.ref !== job.base
      || !pr.body?.includes(marker(job.root)))) throw new PublicationError('conflict');
    const delivered = () => ({ status: 'published', commit: head, pr_number: pr.number, pr_url: pr.html_url });
    const verifyIncluded = async () => {
      await gitImpl(staging, ['fetch', '--no-tags', `https://github.com/${job.github}.git`, `refs/pull/${pr.number}/head:refs/heads/pr-observed`], token);
      if (await gitImpl(staging, ['rev-parse', 'refs/heads/pr-observed']) !== pr.head.sha) throw new PublicationError('conflict');
      try { await gitImpl(staging, ['merge-base', '--is-ancestor', head, pr.head.sha]); }
      catch { throw new PublicationError('conflict'); }
    };
    if (pr && pr.state !== 'open') {
      if (pr.head.sha === head) return delivered(); // Retry after branch deletion: no push is needed.
      if (!pr.merged_at) throw new PublicationError('conflict');
      await verifyIncluded(); return delivered();
    }
    const remote = await api(`/git/ref/heads/${job.branch}`, { missing: true });
    const actual = remote?.object?.sha;
    if (actual && actual !== head && actual !== expected) {
      if (!pr || !job.thread) throw new PublicationError('conflict');
      await verifyIncluded(); return delivered(); // A reviewer already incorporated this exact result.
    }
    if (!actual && expected) throw new PublicationError('conflict');
    if (expected && expected !== head) await gitImpl(staging, ['merge-base', '--is-ancestor', expected, head]);
    if (actual !== head) {
      await gitImpl(staging, ['push', '--porcelain', `https://github.com/${job.github}.git`, `${head}:refs/heads/${job.branch}`], token);
    }
    const confirmed = await api(`/git/ref/heads/${job.branch}`);
    if (confirmed.object?.sha !== head) throw new PublicationError('conflict');
    if (!pr) pr = await api('/pulls', { method: 'POST', body: {
      title: String(job.receipt.title || 'Agents Hub review').replace(/[\r\n]/g, ' ').slice(0, 120),
      head: job.branch, base: job.base, draft: true, body: reviewBody(job),
    } });
    // Follow-up evidence stays in its Hub receipt; never overwrite a human-edited PR body.
    const final = await api(`/pulls/${pr.number}`);
    if (final.head?.sha !== head) { pr = final; await verifyIncluded(); }
    if (final.html_url !== `https://github.com/${job.github}/pull/${pr.number}`) throw new PublicationError('unavailable', true);
    return { status: 'published', commit: head, pr_number: pr.number, pr_url: final.html_url };
  });
}

export async function cleanupMergedReview(config, github, thread, gitImpl = git) {
  if (config.cleanupMergedBranches !== true) return { status: 'disabled' };
  if (thread.branch !== `review/agents/${thread.root}` || !ARTIFACT_RUN_ID.test(thread.root)) throw new PublicationError('conflict');
  const target = targetFor(config, thread.repo, thread.github), token = await github.token(thread.github);
  const prefix = `/repos/${thread.github}`, api = route => github.request(prefix + route, { token });
  const pr = await api(`/pulls/${thread.pr_number}`);
  if (!pr.merged_at || pr.head?.ref !== thread.branch || pr.head?.repo?.full_name !== thread.github || pr.base?.ref !== target.base)
    return { status: 'preserved' };
  const remote = await github.request(prefix + `/git/ref/heads/${thread.branch}`, { token, missing: true });
  if (!remote) return { status: 'already_absent' };
  if (remote.object?.sha !== pr.head.sha) return { status: 'preserved' };
  const open = await api(`/pulls?state=open&head=${encodeURIComponent(thread.github.split('/')[0] + ':' + thread.branch)}&per_page=100`);
  if (open.length) return { status: 'preserved' };
  const ref = `refs/agent-review/merged/${thread.root}`, url = `https://github.com/${thread.github}.git`;
  await gitImpl(target.repository, ['fetch', '--no-tags', url, `refs/heads/${target.base}:${ref}`], token);
  await gitImpl(target.repository, ['merge-base', '--is-ancestor', pr.merge_commit_sha, ref]);
  const proof = { root: thread.root, pr_number: thread.pr_number, head: pr.head.sha, merge_commit: pr.merge_commit_sha };
  const file = path.join(config.state, 'cleanup', thread.root + '.json');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ ...proof, status: 'verified' }), { mode: 0o600, flush: true });
  await gitImpl(target.repository, ['push', `--force-with-lease=refs/heads/${thread.branch}:${pr.head.sha}`, url, `:refs/heads/${thread.branch}`], token);
  await fs.writeFile(file, JSON.stringify({ ...proof, status: 'deleted' }), { mode: 0o600, flush: true });
  return { ...proof, status: 'deleted' };
}
