// Loaded explicitly from a frozen release; project extensions are disabled.
import { sandboxExecute } from './linux-sandbox.mjs';
export default async function (pi: any) {
  const policy = JSON.parse(process.env.AGENT_LINUX_POLICY ?? '{}');
  const sdk = await import(policy.sdk);
  const factories: Record<string, string> = { read: 'createReadTool', grep: 'createGrepTool', find: 'createFindTool',
    ls: 'createLsTool', write: 'createWriteTool', edit: 'createEditTool', bash: 'createBashTool' };
  for (const [name, factory] of Object.entries(factories)) {
    const definition = sdk[factory](policy.workspace);
    pi.registerTool({ name, label: definition.label ?? name, description: definition.description,
      parameters: definition.parameters,
      execute: async (_id: string, args: unknown, signal: AbortSignal) => sandboxExecute(policy, name, args, { signal }) });
  }
}
