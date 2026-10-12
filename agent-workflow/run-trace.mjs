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
