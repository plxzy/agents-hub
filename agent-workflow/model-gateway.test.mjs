import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelGateway } from './model-gateway.mjs';

test('the private gateway module is optional and receives the agent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gateway-'));
  try {
    const file = path.join(dir, 'model-gateway.mjs');
    assert.deepEqual((await modelGateway({}, { file })).env, {});
    fs.writeFileSync(file, 'export async function modelGateway(agent) { return { env: { AGENT: agent.name }, async close() {} }; }');
    assert.deepEqual((await modelGateway({ name: 'helper' }, { file })).env, { AGENT: 'helper' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
