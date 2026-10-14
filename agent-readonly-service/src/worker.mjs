export { AgentRelay } from './agent-relay.mjs';
import dashboardHtml from 'virtual:agents-hub-dashboard';
import { hubFetch } from './worker-core.mjs';

// Cron removal propagates separately from code. Absorb late old events without reviving polling.
export default {
  scheduled: () => {},
  fetch: (request, env) => hubFetch(request, env, dashboardHtml),
};
