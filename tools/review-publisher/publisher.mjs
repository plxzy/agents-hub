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
    const head = job.receipt.commit, expected = job.thread?.commit_sha;
    if (job.thread && (job.thread.repo !== job.receipt.repo || job.thread.branch !== job.branch)) throw new PublicationError('conflict');
    let pr = job.thread ? await api(`/pulls/${job.thread.pr_number}`) : null;
    if (!pr) {
      const prs = await api(`/pulls?state=all&head=${encodeURIComponent(job.github.split('/')[0] + ':' + job.branch)}&per_page=100`);
      if (prs.length > 1) throw new PublicationError('conflict');
      pr = prs[0];
    }
    if (pr && (pr.head.ref !== job.branch || pr.head.repo?.full_name !== job.github || pr.base.ref !== job.base
      || !pr.body?.includes(marker(job.root)))) throw new PublicationError('conflict');
    if (pr && pr.state !== 'open' && pr.head.sha !== head) throw new PublicationError('conflict');
    const remote = await api(`/git/ref/heads/${job.branch}`, { missing: true });
    const actual = remote?.object?.sha;
    if (actual && actual !== head && actual !== expected || !actual && expected) throw new PublicationError('conflict');
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
    if (final.head?.sha !== head || final.html_url !== `https://github.com/${job.github}/pull/${pr.number}`) throw new PublicationError('unavailable', true);
    return { status: 'published', commit: head, pr_number: pr.number, pr_url: final.html_url };
  });
}
