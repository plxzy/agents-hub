import dashboardHtml from 'virtual:agents-hub-dashboard';
import { hubFetch } from './worker-core.mjs';

export default { fetch: (request, env) => hubFetch(request, env, dashboardHtml) };
