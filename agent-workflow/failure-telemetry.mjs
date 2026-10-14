// Bounded receipt diagnostics. Never retain tool arguments/results, reasoning, stacks or credentials.
export function diagnosticMessage(value) {
  if (typeof value !== 'string') return undefined;
  return value.split('\n').slice(0, 20).map(line => {
    if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|secret)["']?\s*[:=]|\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}|Bearer\s+\S+|-----BEGIN.*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\./i.test(line)) return '[redacted diagnostic line]';
    return line.replace(/https?:\/\/\S+/gi, '[URL omitted]')
      .replace(/\/(?:[^\s'"<>]+)/g, '[path omitted]')
      .replace(/\b[A-Z]:\\[^\s]+/gi, '[path omitted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[address omitted]');
  }).join('\n').slice(0, 2000);
}

export function sanitizeFailureContext(value) {
  if (!value || typeof value !== 'object') return undefined;
  const id = v => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(v) && diagnosticMessage(v) === v ? v : undefined;
  return Object.fromEntries(Object.entries({
    phase: ['startup', 'model', 'tool'].includes(value.phase) ? value.phase : undefined,
    last_tool: id(value.last_tool), provider: id(value.provider), model: id(value.model),
    message: diagnosticMessage(value.message),
  }).filter(([, v]) => v !== undefined));
}

const textOf = message => (message?.content ?? []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
const LIMIT = 48000;
export function failureTelemetry() {
  let phase = 'startup', last_tool, provider, model, message, complete = '', current = '';
  const runtime = r => { provider = r?.provider ?? provider; model = r?.model ?? model; };
  return {
    runtime,
    observe(event) {
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        phase = 'tool'; last_tool = event.toolName ?? last_tool;
      }
      if (['message_start', 'message_update', 'message_end'].includes(event.type) && event.message?.role === 'assistant') {
        phase = 'model'; runtime(event.message);
        if (event.type === 'message_start') current = '';
        // Pi's message_update includes its current assistant message, not just a text delta.
        const text = textOf(event.message).slice(0, LIMIT);
        if (text || event.type !== 'message_end') current = text;
        if (event.type === 'message_end') {
          if (current) complete = [complete, current].filter(Boolean).join('\n\n').slice(0, LIMIT);
          current = '';
          if (['error', 'aborted'].includes(event.message.stopReason)) message = event.message.errorMessage || event.message.stopReason;
        }
      }
    },
    partial(error) {
      const output = [complete, current].filter(Boolean).join('\n\n').slice(0, LIMIT);
      return { output, output_partial: Boolean(output), failure_context: sanitizeFailureContext({
        phase, last_tool, provider, model, message: error ?? message,
      }) };
    },
  };
}

export function failureFromEvents(events, error) {
  const telemetry = failureTelemetry();
  for (const event of events) telemetry.observe(event);
  return telemetry.partial(error);
}

/** Final results win; otherwise preserve the last checkpoint after a killed/crashed Pi child. */
export function failedResult(result = {}, checkpoint = {}, error) {
  const output = typeof result.output === 'string' && result.output ? result.output : checkpoint.output ?? '';
  return { ...result, output: typeof output === 'string' ? output.slice(0, LIMIT) : '', output_partial: Boolean(output),
    failure_context: sanitizeFailureContext(result.failure_context ?? {
      ...checkpoint.failure_context, message: checkpoint.failure_context?.message ?? error,
    }) };
}
