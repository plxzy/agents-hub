import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { trustedLoader } from './dev-session-worker.mjs';
import { observedRuntime } from './dev-runtime.mjs';

test('SDK failures preserve output and usage after tools, throws and account exhaustion', async t => {
  const { executeRun, executeSession } = await import('./dev-session-worker.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-failure-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: 'fixture' }));
  const sdk = path.join(root, 'dist/index.mjs');
  fs.writeFileSync(sdk, `
export const createExtensionRuntime = () => ({});
export const SessionManager = { findById: () => null, create: () => ({}) };
export const SettingsManager = { inMemory: () => ({}) };
export const ModelRuntime = { create: async () => ({ getProvider: () => ({}), hasConfiguredAuth: () => true, getModel: (provider,id) => ({provider,id}) }) };
export async function createAgentSession(options) {
 let listener;
 const mode = options.resourceLoader.getAppendSystemPrompt()[0];
 const session = {model:options.model, thinkingLevel: options.thinkingLevel, sessionId:'fixture',
  setModel:async model => {session.model=model}, setThinkingLevel:v=>{session.thinkingLevel=v},
  subscribe:fn=>{listener=fn;return ()=>{}}, dispose(){}, abort:async()=>{},
  prompt:async()=>{
   const message = text=>({role:'assistant', provider:'openai',model:'gpt-6-luna',content:[{type:'text',text}],usage:{totalTokens:12}});
   listener({type:'message_end',message:message('Earlier useful output')});
   listener({type:'tool_execution_start',toolName:mode==='write-limit'?'write':'read'});
   listener({type:'message_update',message:message('Streaming fragment')});
   if(mode==='throw') throw new Error('503 upstream disconnected');
   const success = mode==='success' || (mode==='recover' && options.model.provider==='openai-2');
   listener({type:'message_end',message:{...message(success?'Final answer':''),stopReason:success?'stop':'error',errorMessage:success?undefined:(mode.includes('limit')||mode==='recover')?'429 quota exhausted':'503 upstream disconnected'}});
  }
 }; return {session};
}
`);
  const config = { mode: 'run', policy: { sdk, workspace: root }, tools: [], sessions: path.join(root, 'sessions'),
    conversation_id: 'fixture', runtime: { engine: 'pi-sdk', provider: 'openai', model: 'gpt-6-luna', thinking: 'low' },
    manifest: { agent: 'helper', project: 'fixture', host: 'fixture', commit: 'a'.repeat(40) } };
  for (const execute of [executeRun, executeSession]) {
    for (const prompt of ['error', 'throw', 'limit']) {
      await assert.rejects(execute({ ...config, prompt }, 'fixture only'), error => {
        assert.match(error.partial.output, /Earlier useful output/);
        assert.match(error.partial.output, /Streaming fragment/);
        assert.equal(error.partial.output_partial, true);
        assert.equal(error.partial.failure_context.last_tool, 'read');
        assert.equal(error.partial.failure_context.model, 'gpt-6-luna');
        assert.match(error.partial.failure_context.message, /503|429/);
        assert.deepEqual(error.partial.tool_calls, ['read']);
        assert.ok(error.partial.usage.totalTokens >= 12);
        return true;
      });
    }
    const ok = await execute({ ...config, prompt: 'success' }, 'fixture only');
    assert.equal(ok.output, 'Final answer'); assert.equal(ok.failure_context, undefined);
  }
  await assert.rejects(executeRun({ ...config, prompt: 'write-limit', writable: true, slots: ['openai', 'openai-2'] }, 'fixture'), error => {
    assert.deepEqual(error.partial.slots_used, ['openai'], 'no retry after a write');
    assert.match(error.partial.output, /Earlier useful output/);
    assert.equal(error.partial.failure_context.last_tool, 'write');
    return true;
  });
  const recovered = await executeRun({ ...config, prompt: 'recover', slots: ['openai', 'openai-2'] }, 'fixture');
  assert.deepEqual(recovered.slots_used, ['openai', 'openai-2']);
  assert.equal(recovered.output, 'Final answer'); assert.equal(recovered.failure_context, undefined);
  // Exercise the real child entrypoint and IPC serialization without an external model request.
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...config, prompt: 'error' }));
  const messages = [], result = await new Promise((resolve, reject) => {
    const child = fork(new URL('./dev-session-worker.mjs', import.meta.url), [configFile], { silent: true });
    let stdout = '';
    child.on('message', message => messages.push(message));
    child.stdout.on('data', data => { stdout += data; }); child.stderr.resume();
    child.on('error', reject); child.on('close', code => resolve({ code, value: JSON.parse(stdout) }));
    child.stdin.end('fixture only');
  });
  assert.equal(result.code, 1); assert.equal(result.value.error, 'model turn failed');
  assert.match(result.value.output, /Earlier useful output/);
  assert.equal(result.value.failure_context.last_tool, 'read');
  assert.equal(messages[0].type, 'runtime');
  assert.ok(messages.some(m => m.type === 'checkpoint' && m.partial.output.includes('Earlier useful output')));
});

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
  assert.deepEqual(sessionTools({ mode: 'run', writable: true, tools: ['read', 'bash', 'edit', 'write'] }), ['read', 'bash', 'edit', 'write']);
  assert.throws(() => sessionTools({ mode: 'run', writable: true, tools: ['curl'] }), /Unknown run tool/);
  const { runPreface } = await import('./dev-session-worker.mjs');
  const manifest = { agent: 'workflow', project: 'dev-workflow', commit: 'c'.repeat(40) };
  assert.match(runPreface({ writable: true, manifest }, {}), /no network.*writable clone.*review branch/s);
  assert.match(runPreface({ manifest }, {}), /read-only Linux sandbox.*cannot change files/s);
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

test('account slots are registered with the base catalog and kept only when logged in', async () => {
  const { registerSlots } = await import('./dev-session-worker.mjs');
  const providers = new Map([['openai', { id: 'openai' }]]), auth = new Set(['openai', 'openai-2']);
  const runtime = {
    getModels: (p) => p === 'openai' ? [{ id: 'gpt-6-luna', api: 'openai-responses' }] : [],
    getProvider: (id) => providers.get(id),
    hasConfiguredAuth: (id) => auth.has(id),
    registerNativeProvider: (provider) => { assert.equal(provider.getModels()[0].id, 'gpt-6-luna'); providers.set(provider.id, provider); },
  };
  const accountProvider = (id, label, getModels) => ({ id, label, getModels: () => getModels() });
  const slots = await registerSlots(runtime, { slots: ['openai', 'openai-2', 'openai-3'], accounts_module: 'fake' }, async () => ({ accountProvider }));
  assert.deepEqual(slots, ['openai', 'openai-2']);
  assert.deepEqual(await registerSlots(runtime, { slots: ['openai', 'openai-2'] }), ['openai', 'openai-2']); // already registered
});
