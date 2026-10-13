// Presentation shared by local operations and the bundled HTML dashboard.
// Only receipt facts: never resolve today's checkout or infer a branch from an agent default.
export function runTrace(r = {}) {
  const recorded = (value) => typeof value === 'string' && value.trim() ? value : 'Unavailable — not included in this receipt';
  return [
    ['Repository', recorded(r.repo)],
    ['Workspace', recorded(r.workspace)],
    ['Checkout branch', 'Unavailable — not included in this receipt'],
    ['Review branch', recorded(r.review_ref)],
    ['Base commit', recorded(r.base_commit)],
    ['Recorded commit', recorded(r.commit)],
    ['Logs', 'Unavailable in this view; run output is shown separately'],
  ];
}

export function failureRows(r = {}) {
  const f = r.failure_context;
  if (!f) return [];
  return [['Last phase', f.phase], ['Last tool', f.last_tool], ['Provider', f.provider], ['Model', f.model], ['Diagnostic', f.message]]
    .map(([label, value]) => [label, value || 'Unavailable — not recorded']);
}

const progressAction = (action, tool) => ({ preparing: 'Preparing run', model_started: 'Waiting for model', model_streaming: 'Receiving model response',
  message_completed: 'Model message completed', tool_started: `${tool || 'Tool'} started`, tool_running: `${tool || 'Tool'} running`, tool_completed: `${tool || 'Tool'} completed`,
  tool_error: `${tool || 'Tool'} reported an error`, model_error: 'Model reported an error', export_started: 'Exporting review branch' })[action] || 'Unavailable';

export function progressRows(r = {}, now = Date.now()) {
  const active = ['running', 'unknown'].includes(r.status), p = r.progress;
  if (!p) return active ? [['Progress', 'Unavailable — this run has not published telemetry']] : [];
  const age = now - Date.parse(p.observed_at), seconds = Math.max(0, Math.floor(age / 1000));
  const fresh = Number.isFinite(age) && age >= 0 && age < 30000 && r.status === 'running';
  const freshness = !Number.isFinite(age) || age < 0 ? 'Update time unavailable or clock mismatch'
    : active ? `${seconds}s ago${fresh ? '' : ' — stale observation; current activity unknown'}` : 'Historical observation; run has ended';
  return [
    [fresh ? 'Current phase' : 'Last reported phase', ({ startup: 'Preparing', model: 'Model response', tool: 'Tool execution', export: 'Review export' })[p.phase] || 'Unavailable'],
    ['Latest checkpoint', p.checkpoint ? `${progressAction(p.checkpoint, p.checkpoint_tool)} (${p.checkpoint_at || 'time unavailable'})` : 'No completed checkpoint yet'],
    ['Last action', progressAction(p.action, p.last_tool)], ['Last tool', p.last_tool || 'No tool observed'],
    ['Blocker', p.blocker === 'tool_error' ? 'Last tool reported an error; recovery not yet observed' : p.blocker === 'model_error' ? 'Model reported an error; recovery not yet observed' : 'None reported'],
    ['Progress updated', `${p.observed_at || 'Unavailable'} · ${freshness}`],
  ];
}

export function progressSummary(r = {}, now = Date.now()) {
  if (!['running', 'unknown'].includes(r.status)) return '';
  const rows = progressRows(r, now);
  if (!r.progress) return rows[0][1];
  return `${progressAction(r.progress.action, r.progress.last_tool)} · ${rows.at(-1)[1].split(' · ').at(-1)}`;
}
