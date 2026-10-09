import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedLoader } from './dev-session-worker.mjs';

test('trusted resource loader cannot discover or activate checkout resources', async () => {
  const loader = trustedLoader({ createExtensionRuntime: () => ({ marker: 'frozen' }) }, 'reviewed prompt');
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getAppendSystemPrompt(), ['reviewed prompt']);
  assert.throws(() => loader.extendResources({ skillPaths: ['/workspace/untrusted'] }), /operator/);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().extensions, []);
});
