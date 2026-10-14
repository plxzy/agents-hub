import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupReviews, checkoutReview, finishReview } from './pr-checkouts.mjs';

function fixture(t, mode = 'merge') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo'), remote = path.join(dir, 'remote.git'), state = path.join(dir, 'state');
  fs.mkdirSync(cwd);
  const git = (...args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); } catch (e) { e.status ??= 1; throw e; } };
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(cwd, 'file'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  git('checkout', '-b', 'review/example'); fs.writeFileSync(path.join(cwd, 'file'), 'patch'); git('commit', '-am', 'patch');
  const head = git('rev-parse', 'HEAD'); git('checkout', 'main');
  if (mode === 'squash') { git('merge', '--squash', 'review/example'); git('commit', '-m', 'squashed patch'); }
  else if (mode === 'rebase') { fs.writeFileSync(path.join(cwd, 'other'), 'main advanced'); git('add', '.'); git('commit', '-m', 'base advanced'); git('cherry-pick', head); }
  else git('merge', '--no-ff', 'review/example', '-m', 'merge PR');
  const merged = git('rev-parse', 'HEAD');
  git('clone', '--bare', cwd, remote); git('remote', 'add', 'origin', remote);
  git('--git-dir', remote, 'update-ref', 'refs/pull/1/head', head);
  const pr = { number: 1, merged_at: '2026-10-14T12:00:00Z', merge_commit_sha: merged,
    head: { sha: head, ref: 'review/example', repo: { full_name: 'owner/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } }, html_url: 'https://github.com/owner/repo/pull/1', state: 'closed' };
  const deps = { git: (...args) => args.join(' ') === 'remote get-url origin' ? 'https://github.com/owner/repo.git' : git(...args), api: route => route.endsWith('/pulls/1') ? pr : [pr], idle: () => true };
  return { cwd, state, git, pr, deps, dir, head };
}
for (const mode of ['merge', 'squash', 'rebase']) test(`cleanup proves ${mode} inclusion and is repeatable`, t => {
  const f = fixture(t, mode);
  assert.equal(cleanupReviews({ cwd: f.cwd }, f.state, f.deps).results[0].status, 'eligible');
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].status, 'deleted');
  assert.deepEqual(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results, []);
  assert.equal(f.git('branch', '--show-current'), 'main');
});
test('dirty, ignored, locked and active worktrees survive cleanup; clean inactive worktree is removed', t => {
  const f = fixture(t), wt = path.join(f.dir, 'review'); f.git('worktree', 'add', wt, 'review/example');
  fs.writeFileSync(path.join(wt, 'untracked'), 'keep');
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].status, 'preserved');
  fs.unlinkSync(path.join(wt, 'untracked')); fs.writeFileSync(path.join(wt, '.gitignore'), 'ignored');
  fs.writeFileSync(path.join(wt, 'ignored'), 'keep');
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].status, 'preserved');
  fs.unlinkSync(path.join(wt, '.gitignore')); fs.unlinkSync(path.join(wt, 'ignored'));
  f.git('worktree', 'lock', wt);
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].status, 'preserved');
  f.git('worktree', 'unlock', wt);
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, { ...f.deps, idle: () => false }).results[0].status, 'preserved');
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].status, 'deleted');
  assert.equal(fs.existsSync(wt), false);
});
test('unpublished commits and closed but unmerged PRs remain', t => {
  const f = fixture(t); f.git('checkout', 'review/example'); fs.writeFileSync(path.join(f.cwd, 'file'), 'unpublished'); f.git('commit', '-am', 'unpublished'); f.git('checkout', 'main');
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].status, 'preserved');
  f.pr.merged_at = null;
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].status, 'preserved');
});
test('a branch moving after proof is not deleted', t => {
  const f = fixture(t); let moved = false;
  const deps = { ...f.deps, git: (...args) => {
    if (!moved && args[0] === 'worktree') { moved = true; f.git('update-ref', 'refs/heads/review/example', f.git('rev-parse', 'main')); }
    return f.deps.git(...args);
  } };
  // Context reads worktrees first; move instead immediately after ancestry proof.
  moved = true; let proved = false;
  deps.git = (...args) => {
    const out = f.deps.git(...args);
    if (args[0] === 'merge-base') proved = true;
    if (proved && args[0] === 'worktree') { f.git('update-ref', 'refs/heads/review/example', f.git('rev-parse', 'main')); proved = false; }
    return out;
  };
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, deps).results[0].status, 'preserved');
});

test('checkout uses the PR branch, reuses its worktree and finish releases it for enabled cleanup', t => {
  const f = fixture(t); f.pr.state = 'open'; const mergedAt = f.pr.merged_at; f.pr.merged_at = null;
  const args = { cwd: f.cwd, pr_number: 1 };
  const first = checkoutReview(args, f.state, f.deps);
  assert.equal(first.branch, 'review/example'); assert.equal(first.status, 'ready');
  const again = checkoutReview(args, f.state, f.deps);
  assert.equal(again.path, first.path); assert.equal(again.status, 'already_checked_out');
  f.pr.state = 'closed'; f.pr.merged_at = mergedAt;
  assert.equal(cleanupReviews({ cwd: f.cwd, apply: true }, f.state, f.deps).results[0].reason, 'active review session');
  fs.writeFileSync(path.join(f.state, 'review-cleanup.json'), JSON.stringify({ enabled: true }));
  const done = finishReview(args, f.state, f.deps);
  assert.equal(done.cleanup.results[0].status, 'deleted'); assert.equal(fs.existsSync(first.path), false);
  assert.equal(f.git('branch', '--show-current'), 'main');
});
