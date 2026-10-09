import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeSnapshot } from './src/snapshot.mjs';

const home = process.env.AGENT_HOME ?? path.join(process.env.HOME, '.agents');
const state = process.env.AGENT_WORKFLOW_STATE ?? path.join(process.env.HOME, '.local/state/agent-workflow');

async function files(dir, suffix) { try { return (await fs.readdir(dir)).filter((x) => x.endsWith(suffix)); } catch { return []; } }
async function loadAgents() {
  const dir = path.join(home, 'agents'); const names = await files(dir, '.md'); const result = [];
  for (const file of names) { try {
    const source = await fs.readFile(path.join(dir, file), 'utf8'); const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    const data = {}; for (const line of (frontmatter?.[1] ?? '').split('\n')) { const m = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (m) data[m[1]] = m[2].trim(); }
    data.name ??= file.replace(/\.md$/, ''); result.push(data);
  } catch {} }
  return result;
}
async function loadRuns() {
  const names = await files(path.join(state, 'runs'), '.json'); const result = [];
  for (const file of names) { try { result.push(JSON.parse(await fs.readFile(path.join(state, 'runs', file), 'utf8'))); } catch {} }
  return result;
}

export async function buildSnapshot(context = []) { return sanitizeSnapshot({ generated_at: new Date().toISOString(), agents: await loadAgents(), runs: await loadRuns(), context }); }
export async function publish(endpoint, token, context = []) {
  if (!endpoint || !token) throw new Error('endpoint and token are required');
  const payload = await buildSnapshot(context);
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/snapshots`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`publish failed: HTTP ${response.status}`);
  return response.json();
}

if (import.meta.url === `file://${process.argv[1]}`) publish(process.env.AGENT_READONLY_ENDPOINT, process.env.AGENT_PUBLISH_TOKEN).then((x) => console.log(JSON.stringify(x))).catch((e) => { console.error(e.message); process.exitCode = 1; });
