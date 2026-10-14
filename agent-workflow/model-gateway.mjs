import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Optional model gateway for sandboxed agents, kept outside this repo: a module at AGENT_MODEL_GATEWAY
 * (default ~/.config/agent-workflow/model-gateway.mjs) exporting modelGateway(agent) → { env, close() }.
 * It runs in the unsandboxed launcher, so a provider can authenticate there and give the sandboxed Pi
 * only what `env` passes on. Without the module, agents get no extra environment.
 */
const NONE = { env: {}, async close() {} };
export async function modelGateway(agent, { file = process.env.AGENT_MODEL_GATEWAY
  ?? path.join(os.homedir(), '.config/agent-workflow/model-gateway.mjs') } = {}) {
  if (!fs.existsSync(file)) return NONE;
  const gateway = await import(pathToFileURL(file).href);
  return (await gateway.modelGateway(agent)) ?? NONE;
}
