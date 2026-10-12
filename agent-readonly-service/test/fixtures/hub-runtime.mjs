// Test-only entrypoint: the hosted MCP surface (owner already authenticated) plus runner routes.
export { AgentRelay } from '../../src/agent-relay.mjs';
import { apiFetch, hubFetch } from '../../src/worker-core.mjs';
export default {
  fetch(request, env) {
    return new URL(request.url).pathname.startsWith('/relay/') ? hubFetch(request, env) : apiFetch(request, env, '', 'owner');
  },
};
