import OAuthProvider, { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import dashboardHtml from 'virtual:agents-hub-dashboard';
import { apiFetch, defaultFetch } from './worker-core.mjs';

export default new OAuthProvider({
  apiRoute: ['/mcp', '/v1/agents', '/v1/runs', '/v1/context'],
  apiHandler: { fetch: (request, env) => apiFetch(request, env, dashboardHtml) },
  defaultHandler: { fetch: defaultFetch },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['agents.read', 'offline_access'],
  requiredScopes: ['agents.read'],
  resourceMetadata: { resource: 'https://YOUR-HUB.workers.dev', authorization_servers: ['https://YOUR-HUB.workers.dev'] },
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
  refreshTokenIdleTTL: 2592000,
});
