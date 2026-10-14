// Local PR worktrees. GitHub supplies merge identity; never reset the user's main checkout.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function command(bin, args, cwd) {
  try { return execFileSync(bin, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); }
  catch (e) { const error = Error(`${bin} operation failed; inspect the repository locally`); error.status = bin === 'lsof' && String(e.stderr ?? '').trim() ? undefined : e.status; throw error; }
}
const gitFor = cwd => (...args) => command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', ...args], cwd);
const api = route => JSON.parse(command('gh', ['api', route]));
const ancestor = (git, a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true; } catch (e) { if (e.status === 1) return false; throw e; } };
export function mergedProof(git, tip, pr, base) {
  return !!pr.merged_at && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? '')
    && ancestor(git, tip, pr.head.sha) && ancestor(git, pr.merge_commit_sha, base);
}
export function worktrees(git) {
  return git('worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean).map(block => {
    const fields = Object.fromEntries(block.split('\0').filter(Boolean).map(line => { const i = line.indexOf(' '); return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)]; }));
    return { path: fields.worktree, branch: fields.branch, locked: !!fields.locked };
  });
}
function context(cwd, state, dependencies = {}) {
  if (!path.isAbsolute(cwd ?? '')) throw Error('An absolute repository cwd is required');
  const root = fs.realpathSync(cwd), git = dependencies.git ?? gitFor(root);
  if (fs.realpathSync(git('rev-parse', '--show-toplevel')) !== root) throw Error('Use the repository root');
  if (worktrees(git)[0]?.path !== root) throw Error('Use the primary repository checkout');
  const remote = git('remote', 'get-url', 'origin');
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw Error('A GitHub origin is required');
  const github = match[1], dir = path.join(state, 'review-checkouts', createHash('sha256').update(root).digest('hex').slice(0, 16));
  const request = dependencies.api ?? api;
  const journal = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'checkouts.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
  const save = value => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const file = path.join(dir, 'checkouts.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600, flush: true }); fs.renameSync(file + '.tmp', file); };
  const log = value => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.appendFileSync(path.join(dir, 'cleanup.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600, flush: true }); };
  return { root, git, github, dir, request, journal, save, log, state };
}
function clean(cwd) { return !gitFor(cwd)('status', '--porcelain=v1', '--untracked-files=all', '--ignored'); }
function idle(cwd) {
  // Missing/denied activity inspection is unknown, never permission to remove a worktree.
  try { command('lsof', ['-t', '+D', cwd]); return false; }
  catch (e) { return e.status === 1; }
}
function number(n) { if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid PR number'); return n; }
function enabled(state) {
  try { return JSON.parse(fs.readFileSync(path.join(state, 'review-cleanup.json'), 'utf8')).enabled === true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function prFor(c, n) {
  const pr = c.request(`/repos/${c.github}/pulls/${number(n)}`);
  if (pr.head?.repo?.full_name !== c.github || pr.base?.repo?.full_name !== c.github) throw Error('Only same-repository PRs are supported');
  c.git('check-ref-format', '--branch', pr.head.ref); c.git('check-ref-format', '--branch', pr.base.ref);
  return pr;
}
function cleanupUnlocked({ cwd, apply = false }, state, dependencies = {}) {
  const c = context(cwd, state, dependencies), { git, request, github } = c, records = c.journal(), results = [];
  const branches = git('for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(upstream:short)', 'refs/heads/').split('\n').filter(Boolean);
  for (const line of branches) {
    const [branch, tip, upstream] = line.split('\t');
    if (branch === 'main' || branch === 'master' || !(/^(review\/|pr\d+[-/])/.test(branch) || records[branch])) continue;
    try {
      if (records[branch]?.active) { results.push({ branch, status: 'preserved', reason: 'active review session' }); continue; }
      const head = upstream?.startsWith('origin/') ? upstream.slice(7) : branch;
      const prs = request(`/repos/${github}/pulls?state=closed&head=${encodeURIComponent(github.split('/')[0] + ':' + head)}&per_page=100`);
      const candidates = prs.filter(pr => pr.merged_at && pr.head?.repo?.full_name === github && pr.head.ref === head);
      let proof;
      for (const pr of candidates) {
        git('check-ref-format', '--branch', pr.base.ref);
        const base = `refs/agent-review/bases/${pr.base.ref}`, savedHead = `refs/agent-review/pr/${pr.number}`;
        git('fetch', '--no-tags', 'origin', `+refs/heads/${pr.base.ref}:${base}`, `+refs/pull/${pr.number}/head:${savedHead}`);
        if (git('rev-parse', savedHead) !== pr.head.sha) continue;
        if (mergedProof(git, tip, pr, base)) { proof = { pr_number: pr.number, pr_head: pr.head.sha, merge_commit: pr.merge_commit_sha, base: git('rev-parse', base), tip }; break; }
      }
      if (!proof) { results.push({ branch, status: 'preserved', reason: 'merge inclusion unproven' }); continue; }
      const attached = worktrees(git).filter(w => w.branch === `refs/heads/${branch}`);
      if (attached.some(w => w.locked || w.path === c.root || !(dependencies.clean ?? clean)(w.path) || !(dependencies.idle ?? idle)(w.path))) {
        results.push({ branch, status: 'preserved', reason: 'primary, locked, dirty or active worktree' }); continue;
      }
      if (!apply) { results.push({ branch, status: 'eligible', ...proof }); continue; }
      if (git('rev-parse', `refs/heads/${branch}`) !== tip) throw Error('Branch changed');
      c.log({ branch, phase: 'verified', ...proof });
      for (const w of attached) {
        if (!(dependencies.clean ?? clean)(w.path) || !(dependencies.idle ?? idle)(w.path)) throw Error('Worktree became active');
        git('worktree', 'remove', w.path); // No force; Git independently refuses dirty or locked worktrees.
      }
      if (worktrees(git).some(w => w.branch === `refs/heads/${branch}`)) throw Error('Branch is checked out');
      git('update-ref', '-d', `refs/heads/${branch}`, tip); // Compare-and-delete, including squash/rebase merges.
      try { git('config', '--remove-section', `branch.${branch}`); } catch { /* An unconfigured branch is normal. */ }
      delete records[branch]; c.save(records); c.log({ branch, phase: 'deleted', ...proof });
      results.push({ branch, status: 'deleted', ...proof });
    } catch { results.push({ branch, status: 'preserved', reason: 'verification or cleanup incomplete; inspect locally' }); }
  }
  return { github, results };
}
function checkoutUnlocked({ cwd, pr_number }, state) {
  if (enabled(state)) cleanupUnlocked({ cwd, apply: true }, state);
  const c = context(cwd, state), pr = prFor(c, pr_number);
  if (pr.state !== 'open') throw Error('PR is closed or merged; start new work from current main');
  const branch = pr.head.ref, attached = worktrees(c.git).find(w => w.branch === `refs/heads/${branch}`);
  if (attached) {
    const records = c.journal(); records[branch] = { pr_number, path: attached.path, active: true }; c.save(records);
    return { path: attached.path, branch, pr_url: pr.html_url, status: 'already_checked_out', note: 'Reuse this checkout only after checking for an active session and local changes.' };
  }
  c.git('fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const remote = c.git('rev-parse', `refs/remotes/origin/${branch}`);
  if (remote !== pr.head.sha) throw Error('PR moved during checkout; retry');
  const names = c.git('for-each-ref', '--format=%(refname)', `refs/heads/${branch}`).split('\n');
  if (names.includes(`refs/heads/${branch}`)) {
    const local = c.git('rev-parse', `refs/heads/${branch}`);
    if (!ancestor(c.git, local, remote)) throw Error('Local branch has unpublished or divergent commits; preserve it');
    c.git('update-ref', `refs/heads/${branch}`, remote, local);
  } else c.git('branch', '--track', branch, `origin/${branch}`);
  const destination = path.join(c.dir, 'worktrees', String(pr_number));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  c.git('worktree', 'add', destination, branch);
  const records = c.journal(); records[branch] = { pr_number, path: destination, active: true }; c.save(records);
  return { path: destination, branch, pr_url: pr.html_url, head: remote, status: 'ready' };
}
function finishUnlocked({ cwd, pr_number }, state) {
  const c = context(cwd, state), pr = prFor(c, pr_number), records = c.journal();
  if (records[pr.head.ref]) { records[pr.head.ref].active = false; c.save(records); }
  return { pr_url: pr.html_url, state: pr.merged_at ? 'merged' : pr.state,
    cleanup: cleanupUnlocked({ cwd, apply: enabled(state) }, state) };
}

function locked(args, state, fn, dependencies) {
  const c = context(args.cwd, state, dependencies);
  fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 });
  const lock = path.join(c.dir, 'operation.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw Error('Review operation busy; inspect a stale lock before retrying'); throw e; }
  try { fs.writeFileSync(path.join(lock, 'owner'), String(process.pid), { mode: 0o600 }); return fn(args, state, dependencies); }
  finally { fs.rmSync(lock, { recursive: true }); }
}
export const cleanupReviews = (args, state, dependencies) => locked(args, state, cleanupUnlocked, dependencies);
export const checkoutReview = (args, state) => locked(args, state, checkoutUnlocked);
export const finishReview = (args, state) => locked(args, state, finishUnlocked);
