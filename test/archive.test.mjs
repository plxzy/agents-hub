import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveSuggestions, conversations, runBrief } from '../src/contract.mjs';
import { healthTime } from '../src/health.mjs';
import { fixtures } from '../demo/fixtures.mjs';

const now = Date.parse('2026-10-14T12:00:00.000Z');
const run = (run_id, extra = {}) => ({ run_id, agent: 'builder', status: 'completed', started: `2026-10-14T0${run_id.at(-1)}:00:00.000Z`, tool_calls: 2, ...extra });

test('continuations of one review are grouped under their newest run', () => {
  const groups = conversations([run('a1', { conversation_id: 'a1' }), run('b2'), run('a3', { conversation_id: 'a1' })]);
  assert.deepEqual(groups.map(group => group.members.map(item => item.run_id)), [['a3', 'a1'], ['b2']]);
});

test('archive suggestions cover whole finished reviews and give a reason', () => {
  const merged = { conversation_id: 'm1', review: { pr_number: 4, state: 'merged' } };
  const suggested = archiveSuggestions([
    run('m1', merged), run('m2', merged),
    run('e1', { status: 'interrupted', tool_calls: 0 }),
    run('r1', { feedback: 'good', ended: '2026-10-01T00:00:00.000Z' }),
    run('r2', { feedback: 'good', ended: '2026-10-13T00:00:00.000Z' }),
    run('x1', { conversation_id: 'x1', status: 'interrupted', tool_calls: 0 }), run('x2', { conversation_id: 'x1', status: 'running' }),
    run('k1', { archived_at: '2026-10-14T00:00:00.000Z', status: 'failed', tool_calls: 0 }),
  ], now);
  assert.deepEqual(Object.fromEntries(suggested.map(item => [item.run_id, item.reason])), {
    m2: 'PR #4 merged', m1: 'PR #4 merged', e1: 'stopped before doing anything', r1: 'rated, finished over 7 days ago',
  }, 'recent ratings, active reviews and archived runs are not suggested');
});

test('run briefs keep the review fields the list needs and nothing else', () => {
  const brief = runBrief({ run_id: 'm1', status: 'completed', conversation_id: 'm1', review: { pr_number: 4, state: 'merged', branch: 'private' }, archived_at: '2026-10-14T00:00:00.000Z' });
  assert.deepEqual(brief.review, { pr_number: 4, state: 'merged' });
  assert.equal(brief.conversation_id, 'm1'); assert.equal(brief.archived_at, '2026-10-14T00:00:00.000Z');
  assert.equal('review' in runBrief({ run_id: 'x', review: { pr_number: 'no', state: 'merged' } }), false);
});

test('the fixture demo shows a review conversation, suggestions and an archived run', () => {
  assert.ok(fixtures.runs.some(item => item.archived_at));
  assert.deepEqual(fixtures.archive_suggestions.map(item => item.run_id).sort(), ['demo-4', 'demo-5', 'demo-6']);
});

test('a runner clock a few milliseconds ahead is skew, not a future timestamp', () => {
  assert.deepEqual(healthTime(new Date(now + 14).toISOString(), now), { at: new Date(now + 14).toISOString(), age_ms: 0, problem: null });
  assert.equal(healthTime(new Date(now + 6000).toISOString(), now).problem, 'future');
});
