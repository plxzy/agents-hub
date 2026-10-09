import test from 'node:test';
import assert from 'node:assert/strict';
import { page, sanitizeSnapshot, taskTitle } from '../src/snapshot.mjs';

test('sanitizes agents and runs to public fields', () => {
  const out = sanitizeSnapshot({ agents: [{ name: 'helper', workspace: '/Users/you/project', tools: ['read'] }], runs: [{ run_id: 'r1', task: 'private prompt', tool_calls: [{}], usage: { totalTokens: 4, cost: 0.1 }, raw_events: ['redacted'] }] });
  assert.equal(out.agents[0].workspace, '~/project'); assert.equal(out.runs[0].tool_calls, 1); assert.equal('raw_events' in out.runs[0], false); assert.equal(out.capabilities.run, false);
});

test('tools and skills arrive as lists, comma strings or skill paths', () => {
  const out = sanitizeSnapshot({ agents: [{ name: 'a', tools: 'read, bash', skills: ['/h/.agents/agent-skills/macos-networking'] }, { name: 'b', tools: ['read'], skills: 'none' }] });
  assert.deepEqual(out.agents[0].tools, ['read', 'bash']); assert.deepEqual(out.agents[0].skills, ['macos-networking']); assert.deepEqual(out.agents[1].skills, []);
});

test('only a short first-line title of each task is published', () => {
  assert.equal(taskTitle('Fix the thing\nwith lots of private detail'), 'Fix the thing');
  assert.equal(taskTitle('x'.repeat(300)).length, 120);
  const out = sanitizeSnapshot({ runs: [{ run_id: 'r1', task: 'secret prompt body' }] });
  assert.equal('task' in out.runs[0], false); assert.equal(out.runs[0].title, 'secret prompt body');
});

test('secret-looking values are redacted in place instead of rejecting the snapshot', () => {
  const out = sanitizeSnapshot({ agents: [{ name: 'x', description: 'api_key=abc' }, { name: 'y', workspace: '/Users/you/.ssh' }],
    runs: [{ run_id: 'r1', task: 'use password: hunter2' }, { run_id: 'r2', task: 'fine' }] });
  assert.match(out.agents[0].description, /redacted/); assert.equal(out.agents[1].workspace, undefined);
  assert.match(out.runs[0].title, /redacted/); assert.equal(out.runs[1].title, 'fine');
  assert.doesNotMatch(JSON.stringify(out), /hunter2|abc/);
});

test('pages with bounded cursors', () => { assert.deepEqual(page([1, 2, 3], '1', 1), { items: [2], next_cursor: '2' }); });

test('sanitizing twice keeps everything (publisher and Worker both sanitize)', () => {
  const once = sanitizeSnapshot({ generated_at: '2026-10-09T00:00:00.000Z', pending: { memory: 1, proposals: 0 },
    agents: [{ name: 'helper', tools: 'read', workspace: '/Users/you/x' }],
    runs: [{ run_id: 'r1', agent: 'helper', status: 'completed', task: 'Do it\nmore', tool_calls: [{}, {}], blocked: ['rm'], usage: { totalTokens: 7, cost: 0.2 }, feedback: { rating: 'bad' } }] });
  assert.deepEqual(sanitizeSnapshot(once), once);
  assert.deepEqual(once.runs[0], { run_id: 'r1', agent: 'helper', kind: 'task', status: 'completed', title: 'Do it', tool_calls: 2, blocked: 1, tokens: 7, cost_usd: 0.2, feedback: 'bad' });
  assert.deepEqual(once.pending, { memory: 1, proposals: 0 });
});
