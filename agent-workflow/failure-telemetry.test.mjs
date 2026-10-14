import assert from 'node:assert/strict';
import test from 'node:test';
import { failureTelemetry, failureFromEvents, failedResult, diagnosticMessage, sanitizeFailureContext } from './failure-telemetry.mjs';

const assistant = (text, extra = {}) => ({ role: 'assistant', provider: 'openai', model: 'gpt-6-luna', content: [{ type: 'text', text }], ...extra });
test('failed turn retains earlier output, last tool and provider diagnostic', () => {
  const r = failureFromEvents([
    { type: 'message_end', message: assistant('I found the config.') },
    { type: 'tool_execution_start', toolName: 'read', args: { path: '/private/file' } },
    { type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'private tool result' }] } },
    { type: 'message_end', message: assistant('', { stopReason: 'error', errorMessage: '503 provider temporarily unavailable' }) },
  ]);
  assert.equal(r.output, 'I found the config.'); assert.equal(r.output_partial, true);
  assert.deepEqual(r.failure_context, { phase: 'model', last_tool: 'read', provider: 'openai', model: 'gpt-6-luna', message: '503 provider temporarily unavailable' });
  assert.doesNotMatch(JSON.stringify(r), /private/);
});
test('interrupted streaming text survives an empty terminal error without reasoning', () => {
  const t = failureTelemetry();
  t.observe({ type: 'message_update', message: assistant('Partial answer', { content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Partial answer' }] }) });
  assert.equal(t.partial().output, 'Partial answer');
  t.observe({ type: 'message_end', message: assistant('', { stopReason: 'aborted' }) });
  assert.equal(t.partial().output, 'Partial answer');
  assert.equal(t.partial().failure_context.message, 'aborted');
});
test('crashed child uses checkpoint, final result takes priority and context remains bounded', () => {
  const checkpoint = failureFromEvents([{ type: 'tool_execution_start', toolName: 'read' }, { type: 'message_update', message: assistant('x'.repeat(60000)) }]);
  assert.equal(checkpoint.output.length, 48000);
  assert.equal(failedResult({}, checkpoint, 'Pi process exited').output.length, 48000);
  assert.equal(failedResult({ output: 'final partial' }, checkpoint).output, 'final partial');
  assert.equal(failedResult({}, checkpoint, 'Pi process exited').failure_context.message, 'Pi process exited');
  assert.deepEqual(failureTelemetry().partial('startup failed').failure_context, { phase: 'startup', message: 'startup failed' });
});
test('diagnostics redact credentials, URLs, paths and addresses and reject arbitrary context fields', () => {
  const raw = '503 request failed\nBearer example-secret-token\napi_key=example\nhttps://provider.invalid/?key=private\n/home/name/private/file\nC:\\Users\\name\\file\nname@example.invalid';
  const clean = diagnosticMessage(raw);
  assert.match(clean, /503 request failed/);
  assert.doesNotMatch(clean, /example-secret|api_key|https:|\/home|C:|name@/);
  assert.ok(diagnosticMessage('x'.repeat(4000)).length <= 2000);
  assert.deepEqual(sanitizeFailureContext({ phase: 'anything', last_tool: '../file', provider: 'sk-' + 'a'.repeat(25), stack: 'private' }), {});
});
