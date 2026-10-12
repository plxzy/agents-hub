// The Mac's side of the Agents Hub: it posts receipts, reads accepted memory and mirrors the user's panel decisions.
// The Hub (D1) is the home of runs, ratings and memory notes; this Mac holds only a cache and a git mirror.
// Config: ~/.config/agent-readonly/mac.json (mode 600) {endpoint, token}. That folder is hidden from agent sandboxes;
// only this launcher process reads it. The token can post receipts and read; it cannot rate, decide or start anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HUB_CONFIG = path.join(os.homedir(), '.config/agent-readonly/mac.json');
export const DECIDE_IN_HUB = 'Decide this in the Agents Hub panel (the Hub keeps ratings and memory notes; the Mac cannot decide them).';

/** null when this Mac is not linked to the Hub (or AGENT_HUB=0): everything then works from local files as before. */
export function hubConfig(file = HUB_CONFIG, env = process.env) {
  if (env.AGENT_HUB === '0') return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof c.endpoint !== 'string' || !/^https:\/\//.test(c.endpoint) || typeof c.token !== 'string' || c.token.length < 20) return null;
    return { endpoint: c.endpoint.replace(/\/$/, ''), token: c.token };
  } catch { return null; }
}
// Only the real home (~/.agents) is linked; tests and AGENT_HOME overrides always work from their own files.
const DEFAULT_ROOT = path.join(os.homedir(), '.agents');
export const linkedHub = (root = process.env.AGENT_HOME ?? DEFAULT_ROOT) => (root === DEFAULT_ROOT ? hubConfig() : null);

export async function hubCall(route, { method = 'GET', body, config = hubConfig(), timeoutMs = 5000, fetchImpl = fetch } = {}) {
  if (!config) throw new Error('This Mac is not linked to the Agents Hub');
  const response = await fetchImpl(`${config.endpoint}/relay/mac/${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const detail = await response.json().then((j) => (typeof j?.error === 'string' && j.error.length <= 300 ? j.error : null)).catch(() => null);
    throw new Error(detail ?? `Hub refused (${response.status})`);
  }
  return response.json();
}

/** The same Hub view the hosted widget reads, through the Mac's read-only principal. */
export async function hubPanel(options = {}) {
  const panel = await hubCall('panel', options);
  if (!panel?.status || !Array.isArray(panel.agents) || !Array.isArray(panel.runs) || !Array.isArray(panel.pending)) {
    throw new Error('Hub returned an invalid panel');
  }
  return panel;
}

export const hubRun = (id, options = {}) => hubCall(`runs/${encodeURIComponent(id)}`, options);

// Only these fields leave the Mac. Commands, workspace paths, raw events, transcripts and session files stay local.
const SEND = ['run_id', 'agent', 'kind', 'agent_version', 'status', 'task', 'started', 'ended', 'model', 'thinking', 'output', 'error',
  'tool_calls', 'blocked', 'model_calls', 'usage'];
export function hubReceipt(receipt, proposals = []) {
  const out = Object.fromEntries(SEND.filter((k) => receipt[k] !== undefined && receipt[k] !== null).map((k) => [k, receipt[k]]));
  if (receipt.status === 'unknown') out.status = 'interrupted';
  if (receipt.memory_source) out.memory_source = receipt.memory_source;
  if (receipt.memory_hash) out.memory_hash = receipt.memory_hash;
  if (proposals.length) { out.memory_proposed = proposals.length; out.memory_proposals = proposals; }
  return out;
}

const outbox = (state) => path.join(state, 'hub-outbox');

/** Posts one receipt; if the Hub is unreachable it waits in the outbox and goes out with the next run or `agent sync`. */
export async function sendReceipt(receipt, { state, proposals = [], config = hubConfig(), fetchImpl = fetch } = {}) {
  if (!config) return 'unlinked';
  const body = hubReceipt(receipt, proposals);
  try { await hubCall('runs', { method: 'POST', body, config, fetchImpl }); return 'sent'; }
  catch {
    fs.mkdirSync(outbox(state), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(outbox(state), `${receipt.run_id}.json`), JSON.stringify(body) + '\n', { mode: 0o600 });
    return 'queued';
  }
}

export async function flushOutbox({ state, config = hubConfig(), fetchImpl = fetch } = {}) {
  if (!config || !fs.existsSync(outbox(state))) return 0;
  let sent = 0;
  for (const name of fs.readdirSync(outbox(state)).filter((f) => f.endsWith('.json'))) {
    const file = path.join(outbox(state), name);
    try { await hubCall('runs', { method: 'POST', body: JSON.parse(fs.readFileSync(file, 'utf8')), config, fetchImpl }); fs.rmSync(file); sent++; }
    catch { break; } // Hub down: keep the rest for later
  }
  return sent;
}

/** Accepted notes for an agent's scopes as the Hub holds them, shaped like loadMemory's items; null if unreachable. */
export async function hubMemory(scopes, { config = hubConfig(), fetchImpl = fetch } = {}) {
  if (!config) return null;
  try {
    const bundle = await hubCall(`bundle?scopes=${encodeURIComponent(scopes.join(','))}`, { config, fetchImpl, timeoutMs: 3000 });
    if (!Array.isArray(bundle.memory)) return null;
    return { items: bundle.memory.map((m) => ({ meta: { id: m.id, scope: m.scope, status: 'accepted' }, body: m.body })), hash: bundle.hash };
  } catch { return null; }
}

// Notes waiting for the user's click in the Hub, cached so synchronous local views (dashboard, status) can show them.
const cacheFile = (state) => path.join(state, 'hub-cache.json');
export function cachedPending(state) {
  try { const c = JSON.parse(fs.readFileSync(cacheFile(state), 'utf8')); return Array.isArray(c.pending) ? c.pending.map((p) => ({ ...p, hub: true })) : []; }
  catch { return []; }
}
export async function refreshHubCache({ state, config = hubConfig(), fetchImpl = fetch } = {}) {
  if (!config) return false;
  try {
    const { pending } = await hubCall('pending', { config, fetchImpl, timeoutMs: 3000 });
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cacheFile(state), JSON.stringify({ at: new Date().toISOString(), pending }) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}
