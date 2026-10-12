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

test('one-shot runs get exactly the reviewed read-only tools; development keeps the full set', async () => {
  const { sessionTools, errorClass } = await import('./dev-session-worker.mjs');
  assert.deepEqual(sessionTools({ mode: 'run', tools: ['read', 'grep', 'read'] }), ['read', 'grep']);
  assert.throws(() => sessionTools({ mode: 'run', tools: ['read', 'bash'] }), /read-only/);
  assert.throws(() => sessionTools({ mode: 'run', tools: ['write'] }), /read-only/);
  assert.equal(sessionTools({}).length, 7);
  assert.equal(errorClass('You have hit your ChatGPT usage limit'), 'usage limit reached');
  assert.equal(errorClass('403 subscription_sharing_user_not_eligible'), 'account not eligible');
  assert.equal(errorClass('subscription_sharing_usage_limit_exceeded'), 'usage limit reached');
  assert.equal(errorClass('something /home/vscode/secret path'), 'model turn failed');
});

test('agent runtime comes from the reviewed definition and is checked against the live session', async () => {
  const { agentRuntime } = await import('./dev-runtime.mjs');
  const expected = agentRuntime({ model: 'openai/gpt-6-luna', thinking: 'low' });
  assert.deepEqual({ ...expected }, { engine: 'pi-sdk', provider: 'openai', model: 'gpt-6-luna', thinking: 'low' });
  assert.equal(observedRuntime({ model: { provider: 'openai', id: 'gpt-6-luna' }, thinkingLevel: 'low', sessionId: 's' }, '1.1.0', expected).model, 'gpt-6-luna');
  assert.throws(() => observedRuntime({ model: { provider: 'openai', id: 'gpt-6.1-sol' }, thinkingLevel: 'low' }, '1.1.0', expected), /does not match/);
  assert.throws(() => agentRuntime({ model: 'gpt-6-luna' }), /provider\/model/);
});

test('account pool skips slots at their limit, reports the earliest reset, and classifies limit errors', async () => {
  const { DevelopmentSessions } = await import('./dev-sessions.mjs');
  const { limitKind } = await import('./dev-session-worker.mjs');
  const later = new Date(Date.now() + 3600e3).toISOString(), past = new Date(Date.now() - 1000).toISOString();
  const pool = (states, slots = ['openai', 'openai-2', 'openai-3']) => DevelopmentSessions.prototype.poolSlots.call({ limits: { slots }, accounts: { get: async () => states } });
  assert.deepEqual(await pool([{ slot: 'openai', state: 'cooldown', until: later }, { slot: 'openai-2', state: 'disabled', until: past }]), ['openai-2', 'openai-3']);
  assert.deepEqual(await DevelopmentSessions.prototype.poolSlots.call({ limits: { slots: ['openai'] }, accounts: { get: async () => { throw new Error('offline'); } } }), ['openai']);
  await assert.rejects(pool([{ slot: 'openai', state: 'cooldown', until: later }], ['openai']), new RegExp('until ' + later));
  const posted = [];
  await DevelopmentSessions.prototype.accountLimited.call({ limits: { slots: ['openai'], cooldownMs: 1000, disableMs: 5000 }, accounts: { post: async v => posted.push(v) } }, 'openai', 'account not eligible');
  assert.equal(posted[0].state, 'disabled'); assert.equal(posted[0].last_error_kind, 'account not eligible');
  assert.equal(limitKind('Codex error: subscription_sharing_usage_limit_exceeded'), 'usage limit reached');
  assert.equal(limitKind('403 subscription_sharing_user_not_eligible'), 'account not eligible');
  assert.equal(limitKind("You've hit your usage limit. Try again later."), 'usage limit reached');
  assert.equal(limitKind('500 server error'), null);
});
