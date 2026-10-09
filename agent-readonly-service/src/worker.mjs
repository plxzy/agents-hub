export { AgentRelay } from './agent-relay.mjs';
import dashboardHtml from 'virtual:agents-hub-dashboard';
import { hubFetch } from './worker-core.mjs';

export default {
  fetch: (request, env) => hubFetch(request, env, dashboardHtml),
  // Bound retention even if the Mac disconnects. Completed request-id receipts remain on the Mac.
  scheduled: (_event, env) => env.DB.prepare('DELETE FROM relay_jobs WHERE expires < ?').bind(Date.now() - 300000).run(),
};
