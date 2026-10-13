// Presentation shared by local operations and the bundled HTML dashboard.
// Only receipt facts: never resolve today's checkout or infer a branch from an agent default.
export function publicRunContext(r = {}) {
  const text = v => typeof v === 'string' && v.length <= 200 && !/[\x00-\x1f\x7f]|Bearer\s|\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/i.test(v);
  const sha = v => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v);
  const iso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
  const logs = r.logs;
  return Object.fromEntries(Object.entries({
    repo: text(r.repo) && /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,63}$/.test(r.repo) ? r.repo : undefined,
    checkout_branch: text(r.checkout_branch) && !r.checkout_branch.startsWith('/') ? r.checkout_branch : undefined,
    checkout_detached: r.checkout_detached === true ? true : undefined,
    base_commit: sha(r.base_commit) ? r.base_commit : undefined,
    commit: sha(r.commit) ? r.commit : undefined,
    context_recorded_at: iso(r.context_recorded_at) ? r.context_recorded_at : undefined,
    worktree_dirty: typeof r.worktree_dirty === 'boolean' ? r.worktree_dirty : undefined,
    logs: logs && ['events', 'session'].includes(logs.kind) && ['recorded', 'removed', 'unavailable'].includes(logs.status) && iso(logs.observed_at)
      ? { kind: logs.kind, status: logs.status, observed_at: logs.observed_at } : undefined,
  }).filter(([, v]) => v !== undefined));
}

export function runTrace(r = {}) {
  const recorded = (value) => typeof value === 'string' && value.trim() ? value : 'Unavailable — not included in this receipt';
  const logs = publicRunContext(r).logs;
  const logText = !logs ? 'Unavailable in this view; run output is shown separately'
    : logs.status === 'removed' ? `Unavailable — removed by runner cleanup (${logs.observed_at})`
    : logs.status === 'unavailable' ? `Unavailable — no log observed (${logs.observed_at})`
    : `${logs.kind === 'session' ? 'Pi session history' : 'Pi event log'} recorded at ${logs.observed_at}; current retention unverified. ${r.logs.location || 'Private location unavailable in this view'}`;
  return [
    ['Repository', recorded(r.repo)],
    ['Workspace', recorded(r.workspace)],
    ['Checkout branch', r.checkout_detached === true ? 'Detached HEAD (at start)' : recorded(r.checkout_branch)],
    ['Review branch', recorded(r.review_ref)],
    ['Base commit', recorded(r.base_commit)],
    ['Recorded commit', recorded(r.commit)],
    ['Logs', logText],
    ...(r.recovery ? [['Recovery', r.recovery.state],
      ...(r.recovery.checkpoint_at ? [['Saved checkpoint', r.recovery.checkpoint_at]] : []),
      ...(r.recovery.resumed_by ? [['Resumed run', r.recovery.resumed_by]] : []),
      ...(r.recovery.resumed_from ? [['Previous attempt', r.recovery.resumed_from]] : [])] : []),
    ...(r.context_recorded_at ? [['Context captured', `${r.context_recorded_at} (at start)`],
      ['Working tree at start', typeof r.worktree_dirty === 'boolean' ? r.worktree_dirty ? 'Uncommitted changes present; commit alone does not identify the full input' : 'Clean' : 'Unavailable — not recorded']] : []),
  ];
}

/** Read-time advice, including for old receipts. A suggested category is not a verified root cause.
 * Only terminal status and recorded diagnostics participate; never task/output/tool-result text.
 * Every returned string is owned by this module, not copied from an error or supplied advice.
 */
export function failureGuidance(r = {}) {
  if (!['failed', 'interrupted'].includes(r.status)) return undefined;
  const text = v => typeof v === 'string' ? v.slice(0, 2000) : '';
  const error = text(r.error), diagnostic = text(r.failure_context?.message);
  const message = `${error}\n${diagnostic}`;
  const labels = { handshake_protocol: 'Handshake / protocol', agent_model: 'Agent / model',
    environment_ssh: 'Environment / SSH', policy_permissions: 'Policy / permissions', unknown: 'Unclassified' };
  const advice = (category, next_step, basis = 'recorded diagnostic') => ({ category, label: labels[category], basis, next_step });
  // Supervisor interruption takes precedence over an older checkpoint's model error.
  if (/runner restarted|supervisor restarted|Pi process exited|spawn .+ ENOENT/i.test(error))
    return advice('environment_ssh', 'Check runner health and this run’s private logs; inspect retained work before deciding whether to start another run.');
  if (/\bMRTR\b|\bprotocolVersion\b|\bMCP\b.{0,100}(?:requires|unsupported|incompatible|mismatch)|handshake.{0,60}(?:fail|reject|mismatch)|elicitation.{0,60}(?:requires|unsupported|not supported)/i.test(message))
    return advice('handshake_protocol', 'Compare the received initialize protocolVersion and advertised capabilities with the server requirements; use a compatible connection before retrying.');
  if (/host key verification failed|permission denied \(publickey|\bssh\b.{0,80}(?:refused|failed|timed out|unreachable)/i.test(message))
    return advice('environment_ssh', 'Check SSH reachability and the configured host key and login on the selected runner; preserve host-key verification.');
  if (/execution lease|grant.{0,30}(?:expired|revoked|refused|mismatch)|policy.{0,30}(?:denied|mismatch|refused)|sandbox.{0,30}(?:denied|forbidden)|not (?:allowed|authorized|runnable)|permission denied|EACCES|EPERM|Missing verified Pi runtime|Runtime requires a new approved manifest|knowledge integrity check failed/i.test(message))
    return advice('policy_permissions', 'Check the selected agent’s allowed tools, repository permissions and current approval or lease; obtain the required approval or correct configuration before retrying.');
  if (/model authentication failed|no logged-in account/i.test(message)
      || (r.failure_context?.phase === 'model' && /(?:invalid|expired|revoked).{0,20}(?:credential|token)|\b401\b|unauthori[sz]ed/i.test(message)))
    return advice('agent_model', 'Check the configured model account on this runner and sign in again through its supported login flow if needed.');
  if (/usage[_ ]limit|rate[_ ]limit|\b429\b|too many requests|quota|all accounts are at their limit/i.test(message))
    return advice('agent_model', 'Check the model account’s usage limit and reset time; wait for capacity before considering a new run.');
  if (/context (?:window|length)|maximum context|too many tokens/i.test(message))
    return advice('agent_model', 'Reduce the task context or start a shorter conversation after preserving this run’s partial output.');
  if (/model.{0,40}(?:unavailable|not found|not supported)|provider not available|not[_ ]eligible/i.test(message))
    return advice('agent_model', 'Check that this runner’s configured model is available to its signed-in account.');
  if (/no space left|ENOSPC|free-space watermark|disk.{0,20}(?:limit|full)/i.test(message))
    return advice('environment_ssh', 'Check free disk space on the selected runner; preserve run evidence before clearing space.');
  if (/ENOENT|no such file|cannot find (?:module|package)|Hub definition unreadable/i.test(message)
      || (r.failure_context?.phase !== 'model' && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|connection refused|network is unreachable/i.test(message)))
    return advice('environment_ssh', 'Check the selected runner’s connectivity, required files and dependencies against the recorded error.');
  if (/model turn failed|provider.{0,40}(?:error|unavailable)/i.test(message)
      || (r.failure_context?.phase === 'model' && /\b(?:500|502|503|504)\b|ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|timed out/i.test(message)))
    return advice('agent_model', 'Check the recorded provider diagnostic and model service status; preserve partial output and inspect any changes before considering a new run.');
  return advice('unknown', 'Inspect this run’s recorded error, last phase/tool and private runner logs to establish the cause before considering a new run.', 'insufficient recorded evidence');
}

export function withFailureGuidance(r) {
  // Never trust advice persisted or supplied by a caller; derive it from this receipt each time.
  const { failure_guidance: _ignored, ...receipt } = r;
  const guidance = failureGuidance(receipt);
  return guidance ? { ...receipt, failure_guidance: guidance } : receipt;
}

export function failureRows(r = {}) {
  const f = r.failure_context, guidance = failureGuidance(r);
  return [...(guidance ? [['Failure category (inferred)', guidance.label], ['Next step', guidance.next_step]] : []),
    ...(f ? [['Last phase', f.phase], ['Last tool', f.last_tool], ['Provider', f.provider], ['Model', f.model], ['Diagnostic', f.message]]
      .map(([label, value]) => [label, value || 'Unavailable — not recorded']) : [])];
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

function capabilityNames(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([name, child]) => {
    const full = prefix ? `${prefix}.${name}` : name;
    return child && typeof child === 'object' && !Array.isArray(child) ? [full, ...capabilityNames(child, full)] : [full];
  });
}

/** Configuration facts shown in both run-detail renderers. Missing observations stay explicit. */
export function configurationRows(r = {}) {
  const c = r.configuration ?? {}, runtime = c.runtime ?? r.runtime ?? {}, execution = runtime.mcp;
  const connection = c.mcp_connection;
  const model = runtime.provider && runtime.model ? `${runtime.provider}/${runtime.model}` : r.model;
  return [
    ['Effective model', model || 'Unavailable — not recorded'],
    ['Thinking', runtime.thinking || r.thinking || 'Unavailable — not recorded'],
    ['Pi MCP', execution ? `${execution.status}${execution.source ? ` · ${execution.source}` : ''}` : 'Unavailable — not recorded'],
    ['Negotiated MCP protocol', connection?.protocol_version || 'Unavailable — connection metadata was not propagated'],
    ['Advertised MCP capabilities', connection ? (capabilityNames(connection.capabilities).join(', ') || 'None advertised') : 'Unavailable — connection metadata was not propagated'],
    ['MCP connection source', connection?.source || 'Unavailable — connection metadata was not propagated'],
  ];
}
