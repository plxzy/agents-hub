// Credential-owning Pi process. Never discovers resources from a writable checkout.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandboxExecute } from './linux-sandbox.mjs';
import { DEVELOPMENT_RUNTIME, observedRuntime, runtimeMatches } from './dev-runtime.mjs';
import { failureTelemetry } from './failure-telemetry.mjs';

export function trustedLoader(sdk, prompt) {
  const extensions = { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [prompt], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Resource activation requires an operator'); },
    reload: async () => {},
  };
}

export function errorClass(message = '') {
  const m = String(message);
  if (/not[_ ]eligible/i.test(m)) return 'account not eligible';
  if (/usage[_ ]limit|rate limit|429|too many requests|quota/i.test(m)) return 'usage limit reached';
  if (/unauthori[sz]ed|401|login|auth/i.test(m)) return 'model authentication failed';
  if (/Pinned model unavailable/.test(m)) return 'model unavailable on this runner';
  if (/abort/i.test(m)) return 'aborted';
  return 'model turn failed';
}
const FACTORIES = { read: 'createReadTool', grep: 'createGrepTool', find: 'createFindTool', ls: 'createLsTool',
  write: 'createWriteTool', edit: 'createEditTool', bash: 'createBashTool' };
const READ_ONLY = ['read', 'grep', 'find', 'ls'];
// Development sessions get every tool; one-shot runs get exactly the reviewed agent's tools (read-only unless config.writable).
export function sessionTools(config) {
  if (config.mode !== 'run') return Object.keys(FACTORIES);
  const tools = config.tools ?? [], allowed = config.writable ? Object.keys(FACTORIES) : READ_ONLY;
  if (!Array.isArray(tools) || tools.some(t => !allowed.includes(t))) throw new Error(config.writable ? 'Unknown run tool' : 'Run tools must be read-only');
  return [...new Set(tools)];
}
export function runPreface(config, runtime) {
  const where = config.writable
    ? `Your tools run in an isolated Linux sandbox with no network over a writable clone of ${config.manifest.project} at commit ${config.manifest.commit}; changes are exported afterwards as a review branch.`
    : `Your tools run in an isolated read-only Linux sandbox over a fresh clone of ${config.manifest.project} at commit ${config.manifest.commit}; there is no shell and you cannot change files.`;
  return `Trusted harness runtime (not shell discovery): ${JSON.stringify(runtime)}\nYou are the ${config.manifest.agent} agent, started remotely through Agents Hub on dok. ${where}`;
}
const WRITING = ['write', 'edit', 'bash'];
const sum = (a, b) => (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);

export async function executeSession(config, task) {
  const run = config.mode === 'run', expected = run ? config.runtime : DEVELOPMENT_RUNTIME;
  if (!run && !runtimeMatches(config.manifest.runtime)) throw new Error('Runtime requires a new approved manifest');
  const sdk = await import(config.policy.sdk);
  const piVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(config.policy.sdk), '../package.json'), 'utf8')).version;
  let runtime;
  const names = sessionTools(config);
  const customTools = names.map(name => {
    const definition = sdk[FACTORIES[name]](config.policy.workspace);
    return { name, label: name, description: definition.description, parameters: definition.parameters,
      execute: (_id, args, signal) => sandboxExecute(config.policy, name, args, { signal }) };
  });
  customTools.push({ name: 'session_runtime', label: 'Session runtime',
    description: run ? 'Read trusted Pi session identity, actual provider/model/thinking and executor. This does not launch another agent.'
      : 'Read trusted Pi session identity, actual provider/model/thinking and executor. Pi and agent launchers are intentionally absent from sandbox PATH; you are already the workflow agent. This does not launch another agent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: JSON.stringify(runtime) }], details: runtime }) });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(os.homedir(), '.pi/agent/auth.json'),
    modelsPath: null, allowModelNetwork: false });
  const model = modelRuntime.getModel(expected.provider, expected.model);
  if (!model) throw new Error('Pinned model unavailable');
  const previous = sdk.SessionManager.findById(config.policy.workspace, config.conversation_id, config.sessions);
  const sessionManager = previous ? sdk.SessionManager.open(previous, config.sessions, config.policy.workspace)
    : sdk.SessionManager.create(config.policy.workspace, config.sessions, { id: config.conversation_id });
  const { session } = await sdk.createAgentSession({ cwd: config.policy.workspace, agentDir: config.agentDir,
    modelRuntime, model, thinkingLevel: expected.thinking, noTools: 'builtin', tools: [...names, 'session_runtime'], customTools,
    resourceLoader: trustedLoader(sdk, config.prompt), sessionManager,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [], skills: [], enableSkillCommands: false }) });
  let output = '', calls = [], failed = false, usage = { input: 0, output: 0, totalTokens: 0, cost: 0 }, models = 0;
  const telemetry = failureTelemetry();
  const unsubscribe = session.subscribe(event => {
    telemetry.observe(event);
    if (event.type === 'tool_execution_start') calls.push(event.toolName);
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      models++;
      const u = event.message.usage ?? {};
      usage = { input: sum(usage.input, u.input), output: sum(usage.output, u.output),
        totalTokens: sum(usage.totalTokens, u.totalTokens), cost: sum(usage.cost, u.cost?.total) };
      if (['error', 'aborted'].includes(event.message.stopReason)) failed = event.message.errorMessage || true;
      output = (event.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 64000);
    }
  });
  const abort = () => { void session.abort(); };
  process.once('SIGTERM', abort);
  try {
    // Continuations can restore old settings. Apply the operator-approved setting and
    // inspect SDK getters before inference or any tool execution.
    await session.setModel(model);
    session.setThinkingLevel(expected.thinking);
    runtime = { ...observedRuntime(session, piVersion, expected), host: config.manifest.host,
      implementation_revision: config.manifest.implementation_revision, policy_digest: config.manifest.policy_digest };
    telemetry.runtime(runtime);
    process.send?.({ type: 'runtime', runtime });
    const preface = run
      ? runPreface(config, runtime)
      : `Trusted harness runtime (not shell discovery): ${JSON.stringify(runtime)}\nYou are already the Pi workflow agent. The shell is an isolated Linux tool sandbox; host launchers and credentials are intentionally hidden. Use session_runtime to read this identity.`;
    await session.prompt(`${preface}\n\n${task}`);
    if (failed) throw Object.assign(new Error('Model turn failed'), { detail: typeof failed === 'string' ? failed : undefined });
    observedRuntime(session, piVersion, expected);
    if (run) return { output, tool_calls: calls.slice(0, 500), conversation_id: config.conversation_id, runtime, usage, model_calls: models };
    const git = await sandboxExecute(config.policy, 'bash', { command: 'git -c core.hooksPath=/dev/null rev-parse HEAD' });
    const commit = git.content?.find(c => c.type === 'text')?.text?.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit ?? '')) throw new Error('Cannot identify task commit');
    return { output, tool_calls: calls.slice(0, 500), conversation_id: config.conversation_id, commit, runtime };
  }
  catch (error) {
    error.partial = { ...telemetry.partial(error.detail ?? error.message), tool_calls: calls, usage, model_calls: models };
    throw error;
  }
  finally { unsubscribe(); process.removeListener('SIGTERM', abort); session.dispose(); }
}

// ---------- one-shot runs with an account pool ----------
// Slots are ChatGPT OAuth accounts (openai, openai-2, ...). The supervisor orders them using shared Hub state.
export function limitKind(errorText = '') {
  const kind = errorClass(errorText);
  return ['usage limit reached', 'account not eligible'].includes(kind) ? kind : null;
}
export async function registerSlots(modelRuntime, config, load = specifier => import(specifier)) {
  const wanted = (config.slots ?? ['openai']).filter(s => /^openai(-[1-9]\d*)?$/.test(s));
  if (wanted.some(s => s !== 'openai') && config.accounts_module) {
    const { accountProvider } = await load(config.accounts_module);
    // Each slot lists the same models as the base openai provider; its own OAuth credential is used per request.
    const catalog = () => modelRuntime.getModels('openai');
    for (const slot of wanted) if (slot !== 'openai' && !modelRuntime.getProvider(slot)) {
      try { modelRuntime.registerNativeProvider(accountProvider(slot, slot, catalog)); } catch { /* unavailable slot is skipped */ }
    }
  }
  return wanted.filter(s => modelRuntime.getProvider(s) && modelRuntime.hasConfiguredAuth(s));
}

export async function executeRun(config, task) {
  const sdk = await import(config.policy.sdk);
  const piVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(config.policy.sdk), '../package.json'), 'utf8')).version;
  const names = sessionTools(config);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(os.homedir(), '.pi/agent/auth.json'),
    modelsPath: null, allowModelNetwork: false });
  // Overrides name a provider; the pool applies to the openai provider only.
  const slots = config.runtime.provider === 'openai' ? await registerSlots(modelRuntime, config) : [config.runtime.provider];
  if (!slots.length) throw new Error('No logged-in account for this model');
  let output = '', calls = [], usage = { input: 0, output: 0, totalTokens: 0, cost: 0 }, models = 0, runtime;
  const telemetry = failureTelemetry();
  let checkpointAt = 0;
  const used = [];
  try {
    for (const slot of slots) {
      const expected = { ...config.runtime, provider: slot };
      runtime = undefined;
      const model = modelRuntime.getModel(slot, config.runtime.model);
      if (!model) continue;
      used.push(slot);
      const customTools = names.map(name => {
        const definition = sdk[FACTORIES[name]](config.policy.workspace);
        return { name, label: name, description: definition.description, parameters: definition.parameters,
          execute: (_id, args, signal) => sandboxExecute(config.policy, name, args, { signal }) };
      });
      customTools.push({ name: 'session_runtime', label: 'Session runtime',
        description: 'Read trusted Pi session identity, actual provider/model/thinking and executor. This does not launch another agent.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: 'text', text: JSON.stringify(runtime) }], details: runtime }) });
      // Every attempt is a fresh session unless continuing: no conversation state crosses accounts.
      const sessions = path.join(config.sessions, slot), sessionId = config.conversation_id + '-' + slot;
      fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
      const earlier = config.resume ? sdk.SessionManager.findById(config.policy.workspace, sessionId, sessions) : null;
      const sessionManager = earlier ? sdk.SessionManager.open(earlier, sessions, config.policy.workspace)
        : sdk.SessionManager.create(config.policy.workspace, sessions, { id: sessionId });
      const { session } = await sdk.createAgentSession({ cwd: config.policy.workspace, agentDir: config.agentDir,
        modelRuntime, model, thinkingLevel: expected.thinking, noTools: 'builtin', tools: [...names, 'session_runtime'], customTools,
        resourceLoader: trustedLoader(sdk, config.prompt), sessionManager,
        settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [], skills: [], enableSkillCommands: false }) });
      let failed = null;
      const unsubscribe = session.subscribe(event => {
        telemetry.observe(event);
        // Retain a bounded checkpoint in the supervisor for a process exit with no final JSON.
        if (runtime && process.connected && (Date.now() - checkpointAt >= 1000 || event.type === 'message_end' || event.type === 'tool_execution_start')) {
          checkpointAt = Date.now();
          process.send({ type: 'checkpoint', partial: telemetry.partial() }, () => {});
        }
        if (event.type === 'tool_execution_start') calls.push(event.toolName);
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          models++;
          const u = event.message.usage ?? {};
          usage = { input: sum(usage.input, u.input), output: sum(usage.output, u.output),
            totalTokens: sum(usage.totalTokens, u.totalTokens), cost: sum(usage.cost, u.cost?.total) };
          if (['error', 'aborted'].includes(event.message.stopReason)) failed = event.message.errorMessage || 'error';
          output = (event.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 64000);
        }
      });
      const abort = () => { void session.abort(); };
      process.once('SIGTERM', abort);
      try {
        await session.setModel(model);
        session.setThinkingLevel(expected.thinking);
        runtime = { ...observedRuntime(session, piVersion, expected), host: config.manifest.host,
          implementation_revision: config.manifest.implementation_revision, policy_digest: config.manifest.policy_digest };
        telemetry.runtime(runtime);
        process.send?.({ type: 'runtime', runtime });
        await session.prompt(`${runPreface(config, runtime)}\n\n${task}`);
        if (!failed) {
          observedRuntime(session, piVersion, expected);
          return { output, tool_calls: calls.slice(0, 500), conversation_id: config.conversation_id, runtime, usage, model_calls: models, slots_used: used };
        }
        const kind = limitKind(failed);
        if (!kind) throw Object.assign(new Error('Model turn failed'), { detail: failed });
        // Tell the supervisor so every runner skips this account.
        process.send?.({ type: 'account', slot, kind });
        // Read-only runs are safe to restart elsewhere. A run that may have changed files is not: a new session
        // would meet a half-edited tree.
        if (config.writable && calls.some(c => WRITING.includes(c))) {
          throw Object.assign(new Error(kind), { detail: failed });
        }
        output = '';
      } catch (error) {
        error.partial = { ...telemetry.partial(error.detail ?? error.message), tool_calls: calls, usage, model_calls: models, slots_used: used };
        throw error;
      } finally { unsubscribe(); process.removeListener('SIGTERM', abort); session.dispose(); }
    }
    throw Object.assign(new Error('usage limit reached'), { detail: 'usage limit reached', partial: { ...telemetry.partial(), tool_calls: calls, usage, model_calls: models, slots_used: used } });
  } catch (error) {
    error.partial ??= { ...telemetry.partial(error.detail ?? error.message), tool_calls: calls, usage, model_calls: models, slots_used: used };
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let task = '';
  for await (const chunk of process.stdin) {
    task += chunk;
    if (task.length > 16000) throw new Error('Task too large');
  }
  try { process.stdout.write(JSON.stringify(await (config.mode === 'run' ? executeRun : executeSession)(config, task))); }
  catch (error) {
    // Runs report a bounded error class (e.g. usage limit) and partial usage; never stacks or host paths.
    process.stdout.write(JSON.stringify({ error: errorClass(error.detail ?? error.message),
      ...(error.partial ?? failureTelemetry().partial(error.detail ?? error.message)) }));
    process.stderr.write('Pi task failed; inspect private host state.\n'); process.exitCode = 1;
  }
}
