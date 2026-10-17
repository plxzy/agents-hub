import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgressTelemetry, sanitizeProgress, progressPublisher, appendStep, sanitizeSteps, STEP_LIMIT } from './run-progress.mjs';
import { progressRows, progressSummary } from './run-trace.mjs';
import { runBrief } from './contract.mjs';

test('progress follows observed events and reports only metadata', () => {
  let now = Date.parse('2026-10-13T00:00:00Z');
  const t = runProgressTelemetry(() => now++);
  assert.equal(t.snapshot().phase, 'startup');
  t.observe({ type: 'turn_start' }); assert.equal(t.snapshot().phase, 'model');
  t.observe({ type: 'tool_execution_start', toolName: 'read', args: { token: 'private-argument' } });
  assert.equal(t.snapshot().last_tool, 'read');
  t.observe({ type: 'tool_execution_update', toolName: 'read', partialResult: 'private output' });
  assert.equal(t.snapshot().action, 'tool_running');
  t.observe({ type: 'tool_execution_end', toolName: 'read', isError: true, result: 'private-result' });
  assert.equal(t.snapshot().blocker, 'tool_error'); assert.equal(t.snapshot().checkpoint, 'tool_error');
  t.observe({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private-reasoning' }, { type: 'text', text: 'private-output' }] } });
  assert.equal(t.snapshot().action, 'model_streaming'); assert.equal(t.snapshot().checkpoint, 'tool_error');
  t.observe({ type: 'tool_execution_start', toolName: 'ls' }); assert.equal(t.snapshot().blocker, undefined);
  t.observe({ type: 'tool_execution_end', toolName: 'ls', isError: false });
  assert.equal(t.snapshot().checkpoint_tool, 'ls');
  t.observe({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'private-error' } });
  assert.equal(t.snapshot().blocker, 'model_error');
  assert.doesNotMatch(JSON.stringify(t.snapshot()), /private|content|args|result/);
  assert.equal(t.observe({ type: 'session', text: 'private' }), false);
});

test('progress is bounded, timestamps normalized and arbitrary diagnostics dropped', () => {
  assert.equal(sanitizeProgress({ phase: 'tool', action: 'tool_started', observed_at: 'bad' }), undefined);
  const p = sanitizeProgress({ phase: 'tool', action: 'tool_started', observed_at: '2026-10-13T01:00:00+01:00',
    last_tool: '/private/secret', checkpoint_tool: 'x'.repeat(1000), output: 'private', args: {}, blocker: 'made-up error' });
  assert.deepEqual(p, { phase: 'tool', action: 'tool_started', observed_at: '2026-10-13T00:00:00.000Z' });
});

test('progress display distinguishes freshness, uncertainty, and historical observations', () => {
  const now = Date.parse('2026-10-13T00:00:00Z'), progress = runProgressTelemetry(() => now).snapshot();
  const run = { status: 'running', progress };
  assert.match(JSON.stringify(progressRows(run, now)), /Current phase/);
  assert.match(progressSummary(run, now + 30000), /stale observation; current activity unknown/);
  assert.match(JSON.stringify(progressRows(run, now - 1)), /clock mismatch/);
  assert.match(JSON.stringify(progressRows({ ...run, status: 'unknown' }, now)), /current activity unknown/);
  assert.match(JSON.stringify(progressRows({ ...run, status: 'completed' }, now)), /Historical observation/);
  assert.match(progressSummary({ status: 'running' }), /not published telemetry/);
  assert.equal(progressSummary({ status: 'completed', progress }), '');
  assert.deepEqual(runBrief(run).progress, progress);
  // Running totals travel with progress and fill the brief until the final receipt has its own.
  const counted = { ...run, progress: { ...progress, tool_calls: 4, model_calls: 2, tokens: 900, cost_usd: 0.01 } };
  assert.equal(sanitizeProgress({ ...counted.progress, tool_calls: -1, tokens: 1.5 }).tool_calls, undefined);
  assert.deepEqual([runBrief(counted).tool_calls, runBrief(counted).tokens, runBrief(counted).cost_usd], [4, 900, 0.01]);
  assert.equal(runBrief({ ...counted, tool_calls: ['read'] }).tool_calls, 1);
  assert.match(JSON.stringify(progressRows(counted, now)), /4 tool calls · 2 model calls · 900 tokens/);
  assert.match(JSON.stringify(progressRows({ ...run, last_seen_at: new Date(now + 40000).toISOString() }, now + 45000)), /Current phase/,
    'recent runner contact keeps a long tool current');
  assert.equal(runBrief({ ...run, status: 'completed' }).progress, undefined);
});

test('publication coalesces updates, drains before completion and cannot restart afterwards', async () => {
  const scheduled = [], published = [], canceled = [];
  let resolve;
  const p = progressPublisher(value => { published.push(value); return new Promise(r => { resolve = r; }); }, {
    schedule: fn => { scheduled.push(fn); return scheduled.length; }, cancel: id => canceled.push(id),
  });
  const initial = runProgressTelemetry().snapshot();
  p.update(initial); p.update({ ...initial, phase: 'model', action: 'model_started' });
  assert.equal(scheduled.length, 1);
  scheduled[0](); assert.equal(published[0].action, 'model_started');
  p.update({ ...initial, phase: 'tool', action: 'tool_started', last_tool: 'read' });
  let stopped = false; const drain = p.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  resolve(); await drain;
  p.update(initial); scheduled[0]();
  assert.equal(published.length, 1); assert.equal(scheduled.length, 1);
});

test('publication retries a failure with the newest update while still active', async () => {
  const scheduled = [], seen = [];
  const p = progressPublisher(async value => { seen.push(value.action); if (seen.length === 1) throw Error('offline'); }, {
    schedule: fn => { scheduled.push(fn); return scheduled.length; }, cancel() {},
  });
  const initial = runProgressTelemetry().snapshot(); p.update(initial); scheduled.shift()();
  await new Promise(r => setImmediate(r));
  p.update({ ...initial, phase: 'model', action: 'model_started' }); scheduled.shift()();
  await new Promise(r => setImmediate(r)); await p.stop();
  assert.deepEqual(seen, ['preparing', 'model_started']);
});

test('step history keeps completed actions only, deduplicated and bounded', () => {
  const steps = [], at = i => new Date(Date.UTC(2026, 9, 17, 11, 0, i)).toISOString();
  assert.equal(appendStep(steps, { phase: 'model', action: 'model_streaming', observed_at: at(0) }), false);
  assert.equal(appendStep(steps, { phase: 'tool', action: 'tool_started', last_tool: 'bash', observed_at: at(1) }), true);
  assert.equal(appendStep(steps, { phase: 'tool', action: 'tool_started', last_tool: 'bash', observed_at: at(1) }), false, 'a re-sent snapshot is one step');
  appendStep(steps, { phase: 'model', action: 'message_completed', last_tool: 'bash', observed_at: at(2) });
  assert.deepEqual(steps, [{ at: at(1), action: 'tool_started', tool: 'bash' }, { at: at(2), action: 'message_completed' }]);
  for (let i = 3; i < 100; i++) appendStep(steps, { phase: 'tool', action: 'tool_completed', last_tool: 'read', observed_at: at(i % 60) + i });
  assert.ok(steps.length <= STEP_LIMIT);
  assert.equal(sanitizeSteps([{ at: at(1), action: 'tool_started', tool: 'bash', args: 'rm -rf /' }, { at: 'bad', action: 'tool_started' }, { action: 'x' }])
    .length, 1);
  assert.deepEqual(sanitizeSteps([{ at: at(1), action: 'tool_started', tool: 'bash', args: 'secret' }]), [{ at: at(1), action: 'tool_started', tool: 'bash' }]);
  assert.equal(sanitizeSteps([]), undefined);
  const rows = progressRows({ status: 'running', progress: sanitizeProgress({ phase: 'tool', action: 'tool_started', observed_at: at(5) }),
    progress_steps: [{ at: at(1), action: 'tool_started', tool: 'bash' }, { at: at(2), action: 'tool_completed', tool: 'bash' }] }, Date.parse(at(6)));
  assert.match(JSON.stringify(rows), /Recent steps.*11:00:01 bash started → 11:00:02 bash completed/);
});
