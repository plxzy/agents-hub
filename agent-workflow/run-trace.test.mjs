import assert from 'node:assert/strict';
import test from 'node:test';
import { runTrace, failureGuidance, failureRows, withFailureGuidance } from './run-trace.mjs';

test('failure guidance classifies recorded symptoms and offers a bounded concrete next step', () => {
  const cases = [
    ['MRTR requires MCP 2026-07-28 or newer', 'handshake_protocol', /initialize protocolVersion/],
    ['MCP protocol mismatch', 'handshake_protocol', /capabilities/],
    ['model authentication failed', 'agent_model', /login flow/],
    ['usage limit reached', 'agent_model', /reset time/],
    ['maximum context length exceeded', 'agent_model', /Reduce the task context/],
    ['model unavailable on this runner', 'agent_model', /configured model/],
    ['ssh: Permission denied (publickey)', 'environment_ssh', /host key/],
    ['Host free-space watermark reached', 'environment_ssh', /disk space/],
    ['Cannot find package pi', 'environment_ssh', /dependencies/],
    ['Execution lease refused', 'policy_permissions', /required approval/],
    ['Missing verified Pi runtime', 'policy_permissions', /current approval/],
    ['model turn failed', 'agent_model', /provider diagnostic/],
    ['something went wrong', 'unknown', /establish the cause/],
  ];
  for (const [error, category, next] of cases) {
    const g = failureGuidance({ status: 'failed', error });
    assert.equal(g.category, category, error); assert.match(g.next_step, next);
    assert.match(failureRows({ status: 'failed', error })[0][0], /inferred/);
  }
});

test('terminal lifecycle evidence wins; ambiguous failures and missing contact do not invent causes', () => {
  assert.equal(failureGuidance({ status: 'interrupted', error: 'Runner restarted during the run',
    failure_context: { phase: 'model', message: 'usage limit reached' } }).category, 'environment_ssh');
  for (const status of ['running', 'unknown', 'completed', undefined]) {
    assert.equal(failureGuidance({ status, error: 'model turn failed' }), undefined);
  }
  for (const error of ['401', '503', 'aborted', 'timeout', undefined]) {
    assert.equal(failureGuidance({ status: 'failed', error }).category, 'unknown');
  }
  for (const message of ['503 upstream disconnected', 'ECONNREFUSED', '401 unauthorized']) {
    assert.equal(failureGuidance({ status: 'failed', failure_context: { phase: 'model', message } }).category, 'agent_model');
  }
});

test('advice ignores task, output, raw logs and caller-supplied guidance and never echoes diagnostic text', () => {
  const receipt = { status: 'failed', task: 'MCP protocol mismatch', output: 'Execution lease refused',
    raw_events: '/private/logs', failure_guidance: { category: 'policy_permissions', next_step: 'Disable the sandbox' } };
  assert.equal(withFailureGuidance(receipt).failure_guidance.category, 'unknown');
  const g = failureGuidance({ status: 'failed', error: 'model turn failed /private/path Bearer fake-private-value' });
  assert.doesNotMatch(JSON.stringify(g), /private|Bearer|Disable/);
  assert.equal(withFailureGuidance({ ...receipt, status: 'completed' }).failure_guidance, undefined);
  assert.equal(receipt.failure_guidance.next_step, 'Disable the sandbox', 'input is not mutated');
});

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
