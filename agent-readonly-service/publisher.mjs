// Publishes a sanitized snapshot of the local agents and run receipts to the read-only Worker.
// Reads agents and runs through agent-workflow itself, so the snapshot matches what `agent list` shows.
// Endpoint and token come from the environment or from ~/.config/agent-readonly/publish.env (mode 600),
// a folder the agent sandbox cannot read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRuns, loadAgents } from '../agent-workflow/agent.mjs';
import { pending } from '../agent-workflow/improve.mjs';
import { sanitizeSnapshot } from './src/snapshot.mjs';

export const CONFIG = path.join(os.homedir(), '.config/agent-readonly/publish.env');

export function readConfig(file = CONFIG, env = process.env) {
  const values = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) values[m[1]] = m[2];
    }
  }
  return { endpoint: env.AGENT_READONLY_ENDPOINT ?? values.AGENT_READONLY_ENDPOINT, token: env.AGENT_PUBLISH_TOKEN ?? values.AGENT_PUBLISH_TOKEN };
}

export function buildSnapshot({ root, state, context = [] } = {}) {
  const items = pending(root);
  return sanitizeSnapshot({ generated_at: new Date().toISOString(), agents: loadAgents(root), runs: listRuns(state, { running: true }), context,
    pending: { memory: items.filter((p) => p.kind === 'memory').length, proposals: items.filter((p) => p.kind !== 'memory').length } });
}

export async function publish({ endpoint, token } = readConfig(), options = {}) {
  if (!endpoint || !token) throw new Error(`endpoint and token are required (env or ${CONFIG})`);
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/snapshots`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(buildSnapshot(options)),
  });
  if (!response.ok) throw new Error(`publish failed: HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--dry-run')) console.log(JSON.stringify(buildSnapshot(), null, 2));
  else publish().then((x) => console.log(JSON.stringify(x))).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
