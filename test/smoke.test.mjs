import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_OPS, runBrief, titleOf } from '../src/contract.mjs';
import { healthOf } from '../src/health.mjs';
import { sanitizeProgress } from '../src/run-progress.mjs';

test('public contract is read-only and has stable core operations', () => {
  assert.deepEqual(Object.keys(READ_OPS), ['open_dashboard', 'get_status', 'list_agents', 'list_runs', 'get_run']);
  assert.equal(READ_OPS.open_dashboard.annotations.readOnlyHint, true);
  assert.equal(READ_OPS.get_status.annotations.readOnlyHint, true);
});

test('run briefs redact task bodies while retaining useful status', () => {
  const brief = runBrief({ run_id: 'demo-1', agent: 'reviewer', status: 'completed', task: 'Inspect the sample project', started: '2026-10-14T10:00:00.000Z', ended: '2026-10-14T10:01:00.000Z', tool_calls: 2 });
  assert.equal(brief.title, 'Inspect the sample project');
  assert.equal('task' in brief, false);
  assert.equal(brief.tool_calls, 2);
});

test('health never treats stale history as live runner proof', () => {
  const now = Date.parse('2026-10-14T12:00:00.000Z');
  const health = healthOf({ observation: { online: true, execution_available: true, seen_at: '2026-10-14T10:00:00.000Z' } }, { now, maxAge: 30_000 });
  assert.equal(health.state, 'unknown');
  assert.equal(health.execution_available, false);
});

test('progress is bounded and safe for text rendering', () => {
  const progress = sanitizeProgress({ phase: 'tool', action: 'tool_running', last_tool: 'read_file', observed_at: '2026-10-14T11:59:00.000Z' });
  assert.equal(progress.phase, 'tool');
  assert.equal(progress.last_tool, 'read_file');
  assert.equal('text' in progress, false);
});

test('titles use only the first line and have a hard limit', () => {
  assert.equal(titleOf('one\ntwo'), 'one');
  assert.equal(titleOf('x'.repeat(200)).length, 120);
});
