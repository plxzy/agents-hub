// Test-only entrypoint: the hosted MCP surface (owner already authenticated) plus runner routes.
export { AgentRelay } from '../../src/agent-relay.mjs';
import { apiFetch } from '../../src/worker-core.mjs';
import { relayFetch } from '../../src/relay.mjs';
export default {
  fetch(request, env) {
    return new URL(request.url).pathname.startsWith('/relay/') ? relayFetch(request, env) : apiFetch(request, env, '', 'owner');
  },
};
