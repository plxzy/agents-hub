import test from 'node:test';
import assert from 'node:assert/strict';
import { chatgptCloudClient, dotsClient } from '../src/client.mjs';

test('host clients preserve provenance and expose no mutation methods', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => new Response(JSON.stringify({ items: [], stale: true, snapshot_id: 's1' }), { headers: { 'content-type': 'application/json' } });
  try {
    const chat = chatgptCloudClient('https://example.test', 'read'); const dots = dotsClient('https://example.test', 'read');
    assert.equal((await chat.listAgents()).host, 'chatgpt-cloud'); assert.equal((await dots.resolveContext()).host, 'dots');
  assert.equal(typeof chat.runAgent, 'undefined'); assert.equal(chat.capabilities.run, false);
  } finally { globalThis.fetch = oldFetch; }
});
