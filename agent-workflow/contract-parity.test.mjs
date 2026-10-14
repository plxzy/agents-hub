import test from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_OPS } from './relay-contract.mjs';
import { HOST_OPS, validateDevelopment } from './dev-contract.mjs';

// The Hub validates start_run against the public schema, then forwards to dok as run_start,
// where the stricter host schema validates again. A key accepted publicly but missing there
// passes the first check and fails on dispatch.
test('every public start_run argument that dok runs is accepted by the host run_start schema', () => {
  const publicKeys = Object.keys(RELAY_OPS.start_run.input.properties).filter((k) => k !== 'continue'); // continue is refused on dok
  const host = HOST_OPS.run_start.properties;
  assert.deepEqual(publicKeys.filter((k) => !(k in host)), []);
  for (const key of publicKeys) assert.deepEqual(host[key].type, RELAY_OPS.start_run.input.properties[key].type, key);
});

test('host run_start accepts a PR selection with a positive integer only', () => {
  const base = { request_id: 'request-0001', agent: 'workflow', task: 'Address review' };
  validateDevelopment('run_start', { ...base, pr_number: 12 }, true);
  for (const bad of [0, -1, 1.5, '12']) assert.throws(() => validateDevelopment('run_start', { ...base, pr_number: bad }, true), /Invalid pr_number/);
});
