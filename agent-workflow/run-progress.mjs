// Event metadata only: no reasoning, assistant text, tool arguments or tool results.
const PHASES = ['startup', 'model', 'tool', 'export'];
const ACTIONS = ['preparing', 'model_started', 'model_streaming', 'message_completed', 'tool_started', 'tool_running', 'tool_completed', 'tool_error', 'model_error', 'export_started'];
const iso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined;
const int = v => Number.isSafeInteger(v) && v >= 0 ? v : undefined;
// Running totals so far; the final receipt's tool_calls, model_calls and usage replace them.
const COUNTS = { tool_calls: int, model_calls: int, tokens: int, cost_usd: v => Number.isFinite(v) && v >= 0 ? v : undefined };
export function sanitizeProgress(value) {
  if (!value || !PHASES.includes(value.phase) || !ACTIONS.includes(value.action) || !iso(value.observed_at)) return undefined;
  const tool = v => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : undefined;
  return Object.fromEntries(Object.entries({ phase: value.phase, action: value.action, observed_at: iso(value.observed_at),
    last_tool: tool(value.last_tool), checkpoint: ACTIONS.includes(value.checkpoint) ? value.checkpoint : undefined,
    checkpoint_at: iso(value.checkpoint_at), checkpoint_tool: tool(value.checkpoint_tool),
    blocker: ['tool_error', 'model_error'].includes(value.blocker) ? value.blocker : undefined,
    ...Object.fromEntries(Object.entries(COUNTS).map(([k, valid]) => [k, valid(value[k])])),
  }).filter(([, v]) => v !== undefined));
}

// A bounded step history: completed actions only, newest last, never tool arguments or model text.
export const STEP_LIMIT = 40;
const STEP_ACTIONS = ['model_started', 'message_completed', 'tool_started', 'tool_completed', 'tool_error', 'model_error', 'export_started'];
export function sanitizeSteps(value) {
  if (!Array.isArray(value)) return undefined;
  const tool = v => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : undefined;
  const steps = value.slice(-STEP_LIMIT).map(s => s && STEP_ACTIONS.includes(s.action) && iso(s.at)
    ? Object.fromEntries(Object.entries({ at: iso(s.at), action: s.action, tool: tool(s.tool) }).filter(([, v]) => v !== undefined)) : null).filter(Boolean);
  return steps.length ? steps : undefined;
}
/** Adds a progress snapshot to steps in place when it is a new step; returns whether it was added. */
export function appendStep(steps, progress) {
  const p = sanitizeProgress(progress);
  if (!p || !STEP_ACTIONS.includes(p.action)) return false;
  const step = { at: p.observed_at, action: p.action, ...(p.phase === 'tool' && p.last_tool ? { tool: p.last_tool } : {}) };
  const last = steps.at(-1);
  if (last && last.at === step.at && last.action === step.action && last.tool === step.tool) return false;
  steps.push(step);
  if (steps.length > STEP_LIMIT) steps.splice(0, steps.length - STEP_LIMIT);
  return true;
}

export function runProgressTelemetry(now = () => Date.now()) {
  let value = { phase: 'startup', action: 'preparing', observed_at: new Date(now()).toISOString() };
  return {
    observe(event) {
      let phase, action;
      if (event.type === 'turn_start') { phase = 'model'; action = 'model_started'; }
      if (['message_start', 'message_update', 'message_end'].includes(event.type) && event.message?.role === 'assistant') {
        phase = 'model'; action = event.type === 'message_end' ? 'message_completed' : event.type === 'message_update' ? 'model_streaming' : 'model_started';
        if (['error', 'aborted'].includes(event.message.stopReason)) action = 'model_error';
      }
      if (event.type === 'tool_execution_start') { phase = 'tool'; action = 'tool_started'; }
      if (event.type === 'tool_execution_update') { phase = 'tool'; action = 'tool_running'; }
      if (event.type === 'tool_execution_end') { phase = 'tool'; action = event.isError ? 'tool_error' : 'tool_completed'; }
      if (event.type === 'export_start') { phase = 'export'; action = 'export_started'; }
      if (!action) return false;
      value = { ...value, phase, action, observed_at: new Date(now()).toISOString() };
      if (phase === 'tool') value.last_tool = event.toolName;
      if (['tool_completed', 'tool_error', 'message_completed', 'model_error'].includes(action)) {
        value.checkpoint = action; value.checkpoint_at = value.observed_at;
        value.checkpoint_tool = phase === 'tool' ? event.toolName : undefined;
      }
      if (['tool_error', 'model_error'].includes(action)) value.blocker = action;
      else if (['tool_started', 'tool_completed', 'model_started', 'export_started'].includes(action)) delete value.blocker;
      return true;
    },
    snapshot: () => sanitizeProgress(value),
  };
}

// Publish only the newest observation, serially. Stop drains an in-flight call before the final receipt.
// Failed writes retry while the run lives; they never enter the terminal receipt outbox.
export function progressPublisher(publish, { intervalMs = 5000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let latest, timer, inFlight, stopped = false;
  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    try { if (latest) await publish(latest); } catch { /* retry on next tick */ }
    finally { if (!stopped) timer = schedule(() => { inFlight = tick(); }, intervalMs); }
  };
  return {
    update(value) { if (stopped) return; latest = sanitizeProgress(value); if (!timer && !inFlight) timer = schedule(() => { inFlight = tick(); }, intervalMs); },
    async stop() { stopped = true; cancel(timer); await inFlight; },
  };
}
