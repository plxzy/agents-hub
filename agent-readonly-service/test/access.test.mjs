import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { accessSubject } from '../src/access.mjs';
import { defaultFetch } from '../src/worker-core.mjs';

const env = { ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'hub-audience' };
const request = (token) => new Request('https://hub.test/authorize', { headers: token ? { 'cf-access-jwt-assertion': token } : {} });

test('Access identity requires a valid signature, issuer, audience and lifetime', async () => {
  const keys = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const sign = (changes = {}, key = keys.privateKey) => new SignJWT({ sub: 'owner', iss: env.ACCESS_ISSUER, aud: env.ACCESS_AUD, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, ...changes }).setProtectedHeader({ alg: 'RS256' }).sign(key);
  assert.equal(await accessSubject(request(await sign()), env, keys.publicKey), 'owner');
  for (const token of [await sign({ aud: 'other-app' }), await sign({ iss: 'https://other.test' }), await sign({ exp: 1 }), await sign({ sub: '' }), await sign({}, other.privateKey), 'e30.eyJzdWIiOiJvd25lciJ9.fake']) {
    assert.equal(await accessSubject(request(token), env, keys.publicKey), null);
  }
  assert.equal(await accessSubject(request(), env, keys.publicKey), null);
  assert.equal(await accessSubject(request(await sign()), {}, keys.publicKey), null);
});

test('authorization rejects an unverified identity before touching OAuth storage', async () => {
  const result = await defaultFetch(request('e30.eyJzdWIiOiJvd25lciJ9.fake'), env);
  assert.equal(result.status, 401);
});


test('consent approval and denial consume the stored handle without reparsing form data', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const token = await new SignJWT({ sub: 'owner' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(env.ACCESS_ISSUER).setAudience(env.ACCESS_AUD).setIssuedAt().setExpirationTime('1m').sign(privateKey);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [jwk] });
  let parses = 0;
  const storedRequest = { scope: ['agents.read'] };
  const oauth = {
    async parseAuthRequest() { parses++; return storedRequest; },
    async describeConsent() { return { clientName: '<script>bad</script>', clientDomain: 'client.test', redirectHost: 'client.test', scope: ['agents.read'] }; },
    async beginConsent() { return { handle: 'stored-handle', headers: new Headers() }; },
    async approveConsent(req, handle) { assert.equal(handle, 'stored-handle'); return { request: storedRequest, headers: new Headers() }; },
    async completeAuthorization(options) { assert.equal(options.userId, 'owner'); assert.equal(options.request, storedRequest); return { redirectTo: 'https://client.test/callback' }; },
    async denyConsent(req, handle) { assert.equal(handle, 'stored-handle'); return { redirectTo: 'https://client.test/callback?error=access_denied', headers: new Headers() }; },
  };
  try {
    const bindings = { ...env, OAUTH_PROVIDER: oauth };
    const get = await defaultFetch(request(token), bindings);
    assert.equal(get.status, 200);
    const html = await get.text();
    assert.ok(html.includes('agents.read'));
    assert.ok(!html.includes('<script>'));
    for (const decision of ['approve', 'deny']) {
      const req = new Request('https://hub.test/authorize', { method: 'POST', headers: { 'cf-access-jwt-assertion': token }, body: new URLSearchParams({ handle: 'stored-handle', decision }) });
      const response = await defaultFetch(req, bindings);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://client.test/callback' + (decision === 'deny' ? '?error=access_denied' : ''));
    }
    assert.equal(parses, 1);
  } finally { globalThis.fetch = savedFetch; }
});
