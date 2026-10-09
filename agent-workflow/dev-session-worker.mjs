// Credential-owning Pi process. Never discovers resources from a writable checkout.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandboxExecute } from './linux-sandbox.mjs';
import { DEVELOPMENT_RUNTIME, observedRuntime, runtimeMatches } from './dev-runtime.mjs';

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

export async function executeSession(config, task) {
  if (!runtimeMatches(config.manifest.runtime)) throw new Error('Runtime requires a new approved manifest');
  const sdk = await import(config.policy.sdk);
  const piVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(config.policy.sdk), '../package.json'), 'utf8')).version;
  let runtime;
  const factories = { read: 'createReadTool', grep: 'createGrepTool', find: 'createFindTool', ls: 'createLsTool',
    write: 'createWriteTool', edit: 'createEditTool', bash: 'createBashTool' };
  const customTools = Object.entries(factories).map(([name, factory]) => {
    const definition = sdk[factory](config.policy.workspace);
    return { name, label: name, description: definition.description, parameters: definition.parameters,
      execute: (_id, args, signal) => sandboxExecute(config.policy, name, args, { signal }) };
  });
  customTools.push({ name: 'session_runtime', label: 'Session runtime',
    description: 'Read trusted Pi session identity, actual provider/model/thinking and executor. Pi and agent launchers are intentionally absent from sandbox PATH; you are already the workflow agent. This does not launch another agent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: JSON.stringify(runtime) }], details: runtime }) });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(os.homedir(), '.pi/agent/auth.json'),
    modelsPath: null, allowModelNetwork: false });
  const model = modelRuntime.getModel(DEVELOPMENT_RUNTIME.provider, DEVELOPMENT_RUNTIME.model);
  if (!model) throw new Error('Pinned model unavailable');
  const previous = sdk.SessionManager.findById(config.policy.workspace, config.conversation_id, config.sessions);
  const sessionManager = previous ? sdk.SessionManager.open(previous, config.sessions, config.policy.workspace)
    : sdk.SessionManager.create(config.policy.workspace, config.sessions, { id: config.conversation_id });
  const { session } = await sdk.createAgentSession({ cwd: config.policy.workspace, agentDir: config.agentDir,
    modelRuntime, model, thinkingLevel: DEVELOPMENT_RUNTIME.thinking, noTools: 'builtin', tools: [...Object.keys(factories), 'session_runtime'], customTools,
    resourceLoader: trustedLoader(sdk, config.prompt), sessionManager,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [], skills: [], enableSkillCommands: false }) });
  let output = '', calls = [], failed = false;
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'tool_execution_start') calls.push(event.toolName);
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (['error', 'aborted'].includes(event.message.stopReason)) failed = true;
      output = (event.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 64000);
    }
  });
  const abort = () => { void session.abort(); };
  process.once('SIGTERM', abort);
  try {
    // Continuations can restore old settings. Apply the operator-approved setting and
    // inspect SDK getters before inference or any tool execution.
    await session.setModel(model);
    session.setThinkingLevel(DEVELOPMENT_RUNTIME.thinking);
    runtime = { ...observedRuntime(session, piVersion), host: config.manifest.host,
      implementation_revision: config.manifest.implementation_revision, policy_digest: config.manifest.policy_digest };
    process.send?.({ type: 'runtime', runtime });
    await session.prompt(`Trusted harness runtime (not shell discovery): ${JSON.stringify(runtime)}\nYou are already the Pi workflow agent. The shell is an isolated Linux tool sandbox; host launchers and credentials are intentionally hidden. Use session_runtime to read this identity.\n\n${task}`); if (failed) throw new Error('Model turn failed');
    observedRuntime(session, piVersion);
    const git = await sandboxExecute(config.policy, 'bash', { command: 'git -c core.hooksPath=/dev/null rev-parse HEAD' });
    const commit = git.content?.find(c => c.type === 'text')?.text?.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit ?? '')) throw new Error('Cannot identify task commit');
    return { output, tool_calls: calls.slice(0, 500), conversation_id: config.conversation_id, commit, runtime };
  }
  finally { unsubscribe(); process.removeListener('SIGTERM', abort); session.dispose(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let task = '';
  for await (const chunk of process.stdin) {
    task += chunk;
    if (task.length > 16000) throw new Error('Task too large');
  }
  try { process.stdout.write(JSON.stringify(await executeSession(config, task))); }
  catch { process.stderr.write('Pi task failed; inspect private host state.\n'); process.exitCode = 1; }
}
