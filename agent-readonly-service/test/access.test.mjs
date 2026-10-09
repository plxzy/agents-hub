import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { accessSubject } from '../src/access.mjs';
import { hubFetch } from '../src/worker-core.mjs';

const env = { ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'hub-audience' };
const request = (token) => new Request('https://hub.test/mcp', { headers: token ? { 'cf-access-jwt-assertion': token } : {} });

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

test('/mcp answers only with a valid Access assertion; health and publishing stay outside', async () => {
  const keys = await generateKeyPair('RS256');
  const token = await new SignJWT({ sub: 'owner' }).setProtectedHeader({ alg: 'RS256' }).setIssuer(env.ACCESS_ISSUER).setAudience(env.ACCESS_AUD).setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
  const db = { prepare: () => ({ first: async () => null }) };
  const call = (path, headers = {}) => hubFetch(new Request('https://hub.test' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }), { ...env, DB: db }, '', keys.publicKey);
  assert.equal((await call('/mcp')).status, 401);
  assert.equal((await call('/mcp', { 'cf-access-jwt-assertion': 'e30.eyJzdWIiOiJvd25lciJ9.fake' })).status, 401);
  assert.equal((await call('/mcp/v1/agents', {})).status, 401);
  assert.equal((await call('/mcp', { 'cf-access-jwt-assertion': token })).status, 200); // protocol liveness is independent of snapshot availability
  assert.equal((await hubFetch(new Request('https://hub.test/health'), env)).status, 200);
  assert.equal((await hubFetch(new Request('https://hub.test/authorize'), env)).status, 404);
  const prm = await (await hubFetch(new Request('https://hub.test/.well-known/oauth-protected-resource/mcp'), env)).json();
  assert.deepEqual([prm.resource, prm.authorization_servers], ['https://hub.test/mcp', [env.ACCESS_ISSUER]]);
});
