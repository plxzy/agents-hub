// Operator-pinned runtime identity, separate from the editable project and agent defaults.
import { mcpDisabled } from './run-config.mjs';
export const DEVELOPMENT_RUNTIME = Object.freeze({ engine: 'pi-sdk', provider: 'openai', model: 'gpt-6.1-sol', thinking: 'high' });
export function runtimeMatches(actual, expected = DEVELOPMENT_RUNTIME) {
  return actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
}
// One-shot runs use the reviewed agent definition's model (`provider/model`) and thinking level.
export function agentRuntime(agent) {
  const [provider, ...rest] = String(agent.model ?? '').split('/');
  const model = rest.join('/');
  if (!/^[a-z0-9-]{1,40}$/.test(provider) || !/^[A-Za-z0-9._:-]{1,80}$/.test(model)) throw new Error('Agent model must be provider/model');
  const thinking = agent.thinking ?? 'medium';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) throw new Error('Invalid agent thinking level');
  return Object.freeze({ engine: 'pi-sdk', provider, model, thinking });
}
export function observedRuntime(session, piVersion, expected = DEVELOPMENT_RUNTIME) {
  const runtime = { engine: 'pi-sdk', provider: session.model?.provider, model: session.model?.id,
    thinking: session.thinkingLevel, pi_version: piVersion, conversation_id: session.sessionId,
    source: 'trusted-pi-session', observed_at: new Date().toISOString(),
    // The trusted runner deliberately loads no MCP extensions or server connections.
    mcp: mcpDisabled('trusted-pi-session') };
  if (!runtimeMatches(runtime, expected)) throw new Error('Pi runtime does not match approved model and thinking');
  return runtime;
}
