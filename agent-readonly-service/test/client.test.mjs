import test from 'node:test';
import assert from 'node:assert/strict';
import { chatgptCloudClient, dotsClient } from '../src/client.mjs';

test('host clients preserve provenance and expose no mutation methods', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/example\.test\/mcp\/v1\//);
    assert.equal(init.headers.authorization, 'Bearer read');
    return Response.json({ items: [], stale: true, snapshot_id: 's1' });
  };
  try {
    const chat = chatgptCloudClient('https://example.test', 'read'); const dots = dotsClient('https://example.test', 'read');
    assert.equal((await chat.listAgents()).host, 'chatgpt-cloud'); assert.equal((await dots.resolveContext()).host, 'dots');
  assert.equal(typeof chat.runAgent, 'undefined'); assert.equal(chat.capabilities.run, false);
  } finally { globalThis.fetch = oldFetch; }
});
