import assert from 'node:assert/strict';
import test from 'node:test';
import { runTrace } from './run-trace.mjs';

test('run trace shows exact receipt facts, distinguishing review ref from checkout branch', () => {
  const receipt = { repo: 'vm', workspace: '/historical/worktree', review_ref: 'refs/heads/review/runs/r-test', base_commit: 'a'.repeat(40), commit: 'b'.repeat(40) };
  const trace = Object.fromEntries(runTrace(receipt));
  assert.equal(trace.Repository, receipt.repo);
  assert.equal(trace.Workspace, receipt.workspace);
  assert.equal(trace['Review branch'], receipt.review_ref);
  assert.equal(trace['Base commit'], receipt.base_commit);
  assert.equal(trace['Recorded commit'], receipt.commit);
  assert.match(trace['Checkout branch'], /Unavailable/);
});

test('old, running, failed and redacted receipts never invent missing context or expose raw logs', () => {
  for (const status of ['running', 'failed', 'completed', 'unknown']) {
    const trace = runTrace({ status, agent: 'vm', root: 'private-root', raw_events: '/private/raw', transcript: '/private/transcript', session_file: '/private/session' });
    assert.equal(trace.length, 7);
    assert.ok(trace.every(([, value]) => value.startsWith('Unavailable')));
    assert.doesNotMatch(JSON.stringify(trace), /private|main|HEAD/);
  }
  assert.equal(runTrace({ workspace: '' })[1][1], runTrace()[1][1]);
});
