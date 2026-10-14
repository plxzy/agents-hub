import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Cloudflare adapter is static and has no private bindings', async () => {
  const config = await readFile(new URL('../cloudflare.config.ts', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../cloudflare/worker.mjs', import.meta.url), 'utf8');
  assert.match(config, /cloudflare\/worker\.mjs/);
  assert.doesNotMatch(config + worker, /d1|durable|kv|r2|secret|token|database|relay|runner/i);
});
