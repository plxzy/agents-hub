// Operator-pinned runtime identity, separate from the editable project and agent defaults.
export const DEVELOPMENT_RUNTIME = Object.freeze({ engine: 'pi-sdk', provider: 'openai', model: 'gpt-6.1-sol', thinking: 'high' });
export function runtimeMatches(actual, expected = DEVELOPMENT_RUNTIME) {
  return actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
}
export function observedRuntime(session, piVersion) {
  const runtime = { engine: 'pi-sdk', provider: session.model?.provider, model: session.model?.id,
    thinking: session.thinkingLevel, pi_version: piVersion, conversation_id: session.sessionId,
    source: 'trusted-pi-session', observed_at: new Date().toISOString() };
  if (!runtimeMatches(runtime)) throw new Error('Pi runtime does not match approved model and thinking');
  return runtime;
}
