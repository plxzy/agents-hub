import fs from 'node:fs';
import { createSign } from 'node:crypto';

export class PublicationError extends Error {
  constructor(code, retry = false, delay = 0) { super(code); this.code = code; this.retry = retry; this.delay = delay; }
}
export function githubClient(config, fetchImpl = fetch) {
  const cache = new Map();
  async function request(route, { method = 'GET', body, token, missing = false } = {}) {
    let response;
    try { response = await fetchImpl('https://api.github.com' + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10',
        'user-agent': 'agents-hub-review-publisher', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new PublicationError('unavailable', true); }
    if (response.status === 404 && missing) return null;
    if (!response.ok) {
      const limited = response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'));
      const delay = Math.max(Number(response.headers.get('retry-after')) * 1000 || 0, Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now() || 0);
      throw new PublicationError(limited || response.status >= 500 ? 'unavailable' : response.status === 401 ? 'authentication' : 'rejected', limited || response.status >= 500, delay);
    }
    return response.status === 204 ? null : response.json();
  }
  async function token(repository, { readOnly = false, reviewRead = false } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new PublicationError('rejected');
    const key = repository + ':' + readOnly + ':' + reviewRead, old = cache.get(key);
    if (old && old.until > Date.now() + 120000) return old.value;
    const now = Math.floor(Date.now() / 1000), encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(config.app_id) })}`;
    let jwt;
    try { jwt = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(fs.readFileSync(config.private_key_file), 'base64url'); }
    catch { throw new PublicationError('authentication'); }
    const permissions = readOnly ? { contents: 'read', ...(reviewRead ? { pull_requests: 'read' } : {}) } : { contents: 'write', pull_requests: 'write', workflows: 'write' };
    const result = await request(`/app/installations/${config.installation_id}/access_tokens`, { method: 'POST', token: jwt,
      body: { repositories: [repository.split('/')[1]], permissions } });
    if (!result.token || !Number.isFinite(Date.parse(result.expires_at))) throw new PublicationError('authentication');
    cache.set(key, { value: result.token, until: Date.parse(result.expires_at) });
    return result.token;
  }
  return { token, request, invalidate() { cache.clear(); } };
}
