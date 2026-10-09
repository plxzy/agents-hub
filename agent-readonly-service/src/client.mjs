function readJson(response) {
  return response.json().then((body) => response.ok ? body : Promise.reject(new Error(body.error ?? `HTTP ${response.status}`)));
}

export function createReadOnlyClient(endpoint, token, host) {
  const base = endpoint.replace(/\/$/, '').replace(/\/mcp$/, '') + '/mcp';
  const request = (path) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }).then(readJson).then((body) => ({ ...body, host }));
  return {
    capabilities: { discovery: true, status: true, context: true, run: false, mutate: false },
    listAgents: (query = '') => request(`/v1/agents${query}`),
    getAgent: (name) => request(`/v1/agents/${encodeURIComponent(name)}`),
    listRuns: (query = '') => request(`/v1/runs${query}`),
    getRun: (id) => request(`/v1/runs/${encodeURIComponent(id)}`),
    resolveContext: (query = '') => request(`/v1/context${query}`),
  };
}

export const chatgptCloudClient = (endpoint, token) => createReadOnlyClient(endpoint, token, 'chatgpt-cloud');
export const dotsClient = (endpoint, token) => createReadOnlyClient(endpoint, token, 'dots');
