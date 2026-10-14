import { archiveSuggestions } from '../src/contract.mjs';

export const fixtures = {
  generated_at: '2026-10-14T11:59:00.000Z',
  capabilities: { discovery: true, status: true, context: true, run: false, mutate: false },
  status: { agents: 2, runs: 6, running: 1, pending: { memory: 0, proposals: 1 }, last_run: { run_id: 'demo-3', agent: 'builder', status: 'running', ended: null } },
  agents: [
    { name: 'reviewer', description: 'Checks a change and explains the result.', model: 'fixture/model', tools: ['read'], workspace: 'sample project', last_run: { run_id: 'demo-2', status: 'completed', started: '2026-10-14T11:40:00.000Z' } },
    { name: 'builder', description: 'Shows how a run can report bounded progress.', model: 'fixture/model', tools: ['read', 'write'], workspace: 'isolated sample', last_run: { run_id: 'demo-3', status: 'running', started: '2026-10-14T11:58:00.000Z' } }
  ],
  runs: [
    { run_id: 'demo-0', agent: 'reviewer', kind: 'task', status: 'completed', title: 'Summarise the sample project', started: '2026-10-14T09:00:00.000Z', ended: '2026-10-14T09:01:00.000Z', model: 'fixture/model', tool_calls: 2, blocked: 0, tokens: 300, feedback: 'good', archived_at: '2026-10-14T11:30:00.000Z', output: 'An archived sample run.' },
    { run_id: 'demo-4', agent: 'builder', kind: 'task', status: 'completed', title: 'Add a sample settings page', started: '2026-10-14T10:30:00.000Z', ended: '2026-10-14T10:34:00.000Z', model: 'fixture/model', tool_calls: 9, blocked: 0, tokens: 1840, feedback: 'good', conversation_id: 'demo-4', review: { pr_number: 12, state: 'merged' }, output: 'Opened a draft pull request with the sample settings page.' },
    { run_id: 'demo-5', agent: 'builder', kind: 'task', status: 'completed', title: 'Address review comments on the settings page', started: '2026-10-14T10:50:00.000Z', ended: '2026-10-14T10:52:00.000Z', model: 'fixture/model', tool_calls: 5, blocked: 0, tokens: 960, feedback: null, conversation_id: 'demo-4', review: { pr_number: 12, state: 'merged' }, output: 'Updated the same pull request; the reviewer merged it.' },
    { run_id: 'demo-6', agent: 'reviewer', kind: 'task', status: 'interrupted', title: 'Check the sample build', started: '2026-10-14T11:05:00.000Z', ended: '2026-10-14T11:05:20.000Z', model: 'fixture/model', tool_calls: 0, blocked: 0, tokens: 120, feedback: null },
    { run_id: 'demo-1', agent: 'reviewer', kind: 'task', status: 'completed', title: 'Check the sample interface', started: '2026-10-14T11:20:00.000Z', ended: '2026-10-14T11:21:00.000Z', model: 'fixture/model', tool_calls: 3, blocked: 0, tokens: 412, feedback: 'good', output: 'The sample interface is ready for review.' },
    { run_id: 'demo-2', agent: 'reviewer', kind: 'task', status: 'completed', title: 'Review the latest change', started: '2026-10-14T11:40:00.000Z', ended: '2026-10-14T11:42:00.000Z', model: 'fixture/model', tool_calls: 4, blocked: 0, tokens: 608, feedback: null, output: 'The change keeps the read-only boundary intact.' },
    { run_id: 'demo-3', agent: 'builder', kind: 'task', status: 'running', title: 'Prepare a sample result', started: '2026-10-14T11:58:00.000Z', model: 'fixture/model', tool_calls: 1, blocked: 0, progress: { phase: 'tool', action: 'tool_running', last_tool: 'read', observed_at: '2026-10-14T11:59:00.000Z' } }
  ],
  pending: [{ id: 'demo-note-1', kind: 'proposal', agent: 'reviewer', why: 'A sample review item', body: 'Keep the demo fixture deterministic.' }],
  snapshot: { generated_at: '2026-10-14T11:59:00.000Z', published_at: '2026-10-14T11:59:00.000Z', stale: false },
  relay: { available: false, online: false, enabled: false, agents: [], last_seen_at: null, observed_at: null },
  source: 'fixture demo',
};
// Suggestions are computed the same way a live hub would, at the fixture's own clock.
fixtures.archive_suggestions = archiveSuggestions(fixtures.runs, Date.parse(fixtures.generated_at));
