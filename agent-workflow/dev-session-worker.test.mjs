import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedLoader } from './dev-session-worker.mjs';
import { observedRuntime } from './dev-runtime.mjs';

test('runtime evidence reads actual SDK state and rejects fallback before execution', () => {
  const session = { model: { provider: 'openai', id: 'gpt-6.1-sol' }, thinkingLevel: 'high', sessionId: 'conversation' };
  assert.equal(observedRuntime(session,'1.1.0').source,'trusted-pi-session');
  assert.equal(observedRuntime(session,'1.1.0').thinking,'high');
  assert.throws(()=>observedRuntime({...session,thinkingLevel:'medium'},'1.1.0'),/does not match/);
  assert.throws(()=>observedRuntime({...session,model:undefined},'1.1.0'),/does not match/);
});

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
