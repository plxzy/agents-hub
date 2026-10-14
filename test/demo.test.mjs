import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures } from '../demo/fixtures.mjs';

test('fixture demo is read-only and contains no private deployment data', () => {
  const text = JSON.stringify(fixtures);
  assert.equal(fixtures.capabilities.run, false);
  assert.equal(fixtures.capabilities.mutate, false);
  assert.doesNotMatch(text, /dok|owner-|cloudflareaccess|Bearer|secret|password|\/Users\/|\/home\//i);
});
