import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistRunCompletion, DevelopmentSessions } from './dev-sessions.mjs';

test('production finalization persists results and MCP metadata before cleanup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-finalization-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const done of [true, false]) for (const mcp_connection of [undefined, { protocol_version: '2025-11-25', capabilities: {} }]) {
    const file = path.join(dir, 'receipt.json'), workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const runtime = { provider: 'openai', model: 'gpt-6-luna', thinking: 'low' };
    const receipt = { run_id: 'r-20261013T000000Z-abcdef', status: 'running', mcp_connection };
    let cleaned = false;
    const r = persistRunCompletion({ file, receipt, done, code: done ? 0 : 1,
      result: { runtime, output: 'Useful answer', tool_calls: ['read'], ...(done ? {} : { error: 'model turn failed', output_partial: true }) },
      cleanup() {
        assert.equal(JSON.parse(fs.readFileSync(file)).output, 'Useful answer');
        cleaned = true; fs.rmSync(workspace, { recursive: true });
      } });
    assert.equal(r.status, done ? 'completed' : 'failed');
    assert.equal(r.configuration.runtime.model, 'gpt-6-luna');
    assert.equal(Boolean(r.configuration.mcp_connection), Boolean(mcp_connection));
    assert.equal(cleaned, done);
    assert.equal(fs.existsSync(workspace), !done);
  }
});

test('disk failure preserves workspace; cleanup failure preserves completed result', () => {
  let cleaned = false, persisted;
  const args = { file: 'unused', receipt: {}, result: { output: 'answer' }, done: true, code: 0,
    cleanup: () => { cleaned = true; throw Error('cleanup failed'); } };
  assert.throws(() => persistRunCompletion({ ...args, persist() { throw Error('disk full'); } }), /disk full/);
  assert.equal(cleaned, false);
  assert.equal(persistRunCompletion({ ...args, persist(_file, r) { persisted = r; } }).status, 'completed');
  assert.equal(persisted.output, 'answer');
});

test('failed finalization releases only its run and tolerates unavailable storage', () => {
  const host = Object.assign(Object.create(DevelopmentSessions.prototype), {
    state: '/nonexistent/fixture', runs: new Map([['one', {}], ['two', {}]]), report: async () => {},
  });
  host.finalizationFailed({ run_id: 'one' });
  assert.deepEqual([...host.runs.keys()], ['two']);
});
