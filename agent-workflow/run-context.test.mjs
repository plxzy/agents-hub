import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureRunContext, logObservation } from './run-context.mjs';

test('context observes actual branch, detached HEAD, commits and dirty state without changing Git', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'agent-run');
  fs.writeFileSync(path.join(dir, 'file'), 'one'); git('add', 'file');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
  const before = captureRunContext(dir);
  assert.equal(before.workspace, fs.realpathSync(dir)); assert.equal(before.checkout_branch, 'agent-run');
  assert.equal(before.base_commit, git('rev-parse', 'HEAD')); assert.equal(before.worktree_dirty, false);
  assert.equal(before.checkout_detached, undefined);
  fs.appendFileSync(path.join(dir, 'file'), 'two');
  assert.equal(captureRunContext(dir).worktree_dirty, true);
  git('checkout', '-q', '--detach');
  const detached = captureRunContext(dir);
  assert.equal(detached.checkout_detached, true); assert.equal(detached.checkout_branch, undefined);
  assert.equal(detached.base_commit, before.base_commit);
  assert.equal(before.checkout_branch, 'agent-run', 'earlier observations do not change with the checkout');
});

test('non-Git and missing workspaces do not invent repository facts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const target of [dir, path.join(dir, 'absent')]) {
    const r = captureRunContext(target);
    assert.equal(r.checkout_branch, undefined); assert.equal(r.base_commit, undefined); assert.equal(r.repo, undefined);
  }
});

test('log metadata checks existing JSONL without reading contents or following symlinks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  assert.equal(logObservation(file, 'events').status, 'unavailable');
  fs.writeFileSync(file, 'private event contents');
  const r = logObservation(file, 'events');
  assert.equal(r.status, 'recorded'); assert.equal(r.location, file);
  assert.doesNotMatch(JSON.stringify(r), /private event contents/);
  fs.symlinkSync(file, path.join(dir, 'link.jsonl'));
  assert.equal(logObservation(path.join(dir, 'link.jsonl'), 'events').status, 'unavailable');
  assert.equal(logObservation(dir, 'session').status, 'recorded');
  fs.rmSync(file); assert.equal(logObservation(file, 'events').status, 'unavailable');
});
