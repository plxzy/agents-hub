import test from 'node:test';
import assert from 'node:assert/strict';
import { page, sanitizeSnapshot } from '../src/snapshot.mjs';

test('sanitizes agents and runs to public fields', () => {
  const out = sanitizeSnapshot({ agents: [{ name: 'helper', workspace: '/Users/you/project', tools: ['read'] }], runs: [{ run_id: 'r1', task: 'private prompt', tool_calls: [{}], usage: { totalTokens: 4, cost: 0.1 }, raw_events: ['redacted'] }] });
  assert.equal(out.agents[0].workspace, '~/project'); assert.equal(out.runs[0].tool_calls, 1); assert.equal('raw_events' in out.runs[0], false); assert.equal(out.capabilities.execute, false);
});

test('rejects secrets and sensitive paths', () => {
  assert.throws(() => sanitizeSnapshot({ agents: [{ name: 'x', description: 'api_key=abc' }] }), /disallowed/);
  assert.throws(() => sanitizeSnapshot({ agents: [{ name: 'x', workspace: '/Users/you/.ssh' }] }), /disallowed/);
});

test('pages with bounded cursors', () => { assert.deepEqual(page([1, 2, 3], '1', 1), { items: [2], next_cursor: '2' }); });
