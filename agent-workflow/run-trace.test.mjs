import assert from 'node:assert/strict';
import test from 'node:test';
import { runTrace, failureGuidance, failureRows, withFailureGuidance, publicRunContext, configurationRows } from './run-trace.mjs';

test('next actions retain original patch identity after a no-edit review and route eligible failures to recovery', () => {
  const id = 'r-20261014T000000Z-abcdef', next = 'r-20261014T000001Z-abcdef';
  const source = { run_id: id, base_commit: 'a'.repeat(40), commit: 'b'.repeat(40), review_ref: `refs/heads/review/runs/${id}` };
  const r = withFailureGuidance({ run_id: next, status: 'completed', commit: source.commit, source_review: source, changed_files: [] });
  assert.equal(r.next_action.continue_from, next);
  assert.deepEqual(r.next_action.source_review, source);
  assert.equal(r.review_ref, undefined);
  assert.equal(withFailureGuidance({ ...r, commit: 'c'.repeat(40) }).next_action, undefined);
  const failure = withFailureGuidance({ run_id: id, status: 'failed', error: 'model turn failed',
    failure_context: { phase: 'model', message: 'OpenAI Responses stream ended before a terminal response event' },
    recovery: { state: 'ready', retained: true, checkpoint_version: 827, failed_resume_supported: true } });
  assert.deepEqual(failure.next_action, { tool: 'resume_run', run_id: id, checkpoint_version: 827 });
});

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
  const receipt = { repo: 'vm', workspace: '/historical/worktree', checkout_branch: 'main', review_ref: 'refs/heads/review/runs/r-test', base_commit: 'a'.repeat(40), commit: 'b'.repeat(40), logs: { kind: 'events', status: 'recorded', observed_at: '2026-10-13T01:00:00Z', location: '/private/run.jsonl' } };
  const trace = Object.fromEntries(runTrace(receipt));
  assert.equal(trace.Repository, receipt.repo);
  assert.equal(trace.Workspace, receipt.workspace);
  assert.equal(trace['Saved run snapshot'], receipt.review_ref);
  assert.equal(trace['Base commit'], receipt.base_commit);
  assert.equal(trace['Recorded commit'], receipt.commit);
  assert.equal(trace['Checkout branch'], receipt.checkout_branch);
  assert.match(trace.Logs, /private\/run.jsonl/);
  assert.match(trace.Logs, /current retention unverified/);
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

test('trace publishing strips private paths and arbitrary log payloads; detached and removed states stay explicit', () => {
  const source = { workspace: '/private/workspace', checkout_detached: true, context_recorded_at: '2026-10-13T01:00:00Z', worktree_dirty: true,
    logs: { kind: 'session', status: 'removed', observed_at: '2026-10-13T01:01:00Z', location: '/private/logs', contents: 'private' } };
  const safe = publicRunContext(source), rows = Object.fromEntries(runTrace(safe));
  assert.doesNotMatch(JSON.stringify(safe), /private|contents|location|workspace/);
  assert.equal(rows['Checkout branch'], 'Detached HEAD (at start)');
  assert.match(rows.Logs, /removed by runner cleanup/);
  assert.match(rows['Working tree at start'], /Uncommitted changes/);
  assert.equal(publicRunContext({ checkout_branch: 'Bearer fake-value', logs: { status: 'recorded' } }).checkout_branch, undefined);
  assert.equal(publicRunContext({ checkout_branch: 'main\nprivate' }).checkout_branch, undefined);
});

test('configuration rows distinguish trusted Pi MCP policy from an observed host handshake', () => {
  const rows = Object.fromEntries(configurationRows({ model: 'openai/gpt-6-luna', configuration: {
    runtime: { provider: 'openai', model: 'gpt-6-luna', thinking: 'high', mcp: { status: 'disabled', source: 'pi-launcher --no-mcp' } },
    mcp_connection: { status: 'negotiated', protocol_version: '2026-07-28', capabilities: { tools: { listChanged: true }, elicitation: { form: {} } }, source: 'local-mcp-initialize' },
  }}));
  assert.equal(rows['Effective model'], 'openai/gpt-6-luna');
  assert.equal(rows.Thinking, 'high');
  assert.match(rows['Pi MCP'], /disabled/);
  assert.equal(rows['Negotiated MCP protocol'], '2026-07-28');
  assert.match(rows['Advertised MCP capabilities'], /tools\.listChanged/);
  assert.match(rows['Advertised MCP capabilities'], /elicitation\.form/);
});

test('stopped runs that nothing can continue point at the operator action that applies', () => {
  const base = { run_id: 'r-20261014T190428Z-22dfa4', status: 'failed', error: 'model turn failed',
    failure_context: { phase: 'model', message: 'Request refused' } };
  const paused = withFailureGuidance({ ...base, recovery: { state: 'paused', retained: true, checkpoint_version: 3, reason: 'Failure requires operator inspection before recovery' } });
  assert.equal(paused.next_action.tool, 'dismiss_run'); assert.match(paused.next_action.note, /operator inspection/);
  const inspecting = withFailureGuidance({ ...base, status: 'interrupted', recovery: { state: 'awaiting_review', retained: true, checkpoint_version: 3 } });
  assert.equal(inspecting.next_action.tool, 'retry_inspection');
  const limited = withFailureGuidance({ ...base, status: 'interrupted', recovery: { state: 'paused', retained: true, checkpoint_version: 3, reason: 'Automatic recovery attempt limit reached' } });
  assert.deepEqual(limited.next_action, { tool: 'resume_run', run_id: base.run_id, checkpoint_version: 3 });
  assert.equal(withFailureGuidance({ ...base, recovery: { state: 'dismissed', retained: true } }).next_action, undefined);
});

test('dependency restore outcome is public without leaking paths or private fields', async () => {
  const { publicRunContext } = await import('./run-trace.mjs');
  const got = publicRunContext({ dependencies: { installed: ['.', 'agent-workflow', '../escape', '/abs'], secret: 'x',
    skipped: [{ dir: 'agent-readonly-service', reason: "EACCES: open '/home/agent/.local/state/dok-agent/deps/x.tgz'", extra: 1 }, { dir: '/bad', reason: 'r' }] } });
  assert.deepEqual(got.dependencies, { installed: ['.', 'agent-workflow'], skipped: [{ dir: 'agent-readonly-service', reason: "EACCES: open '<path>'" }] });
  assert.equal(publicRunContext({ dependencies: 'nope' }).dependencies, undefined);
});
