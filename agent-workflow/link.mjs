// Outbound-only relay client. Private config/journal are outside every agent's write permissions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { callOp, defaultContext, dashboardData } from './ops.mjs';
import { getAgent } from './agent.mjs';
import { RELAY_OPS, validateRelay } from './relay-contract.mjs';
import { containsSecret } from '../agent-readonly-service/src/snapshot.mjs';
import { publish } from '../agent-readonly-service/publisher.mjs';

export const LINK_DIR = path.join(os.homedir(), '.config/agent-readonly');
export const LINK_CONFIG = path.join(LINK_DIR, 'link.json');
export function readLink(file = LINK_CONFIG) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^https:\/\//.test(c.endpoint) || typeof c.token !== 'string' || c.token.length < 32) throw new Error('Invalid link endpoint or credential');
  if (!Array.isArray(c.agents) || c.agents.some((a) => typeof a !== 'string')) throw new Error('Invalid remote allowlist');
  return c;
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
// Best-effort redaction supplements the agent sandbox. No raw event/transcript files cross the relay.
function scrub(value) {
  if (typeof value === 'string') return containsSecret(value) ? '[redacted: looked like a secret]' : value.length > 64000 ? value.slice(0, 64000) + '\n[truncated; full output is on the Mac]' : value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}
export async function executeJob(job, { config, ctx = defaultContext(), journal = path.join(LINK_DIR, 'relay-journal'), execute = callOp } = {}) {
  validateRelay(job.operation, job.args);
  if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(job.id) || !Number.isFinite(job.expires) || job.expires <= Date.now()) throw new Error('Expired or invalid request');
  const { request_id, ...args } = job.args;
  const op = RELAY_OPS[job.operation];
  if (!op.read && request_id !== job.id) throw new Error('Request id mismatch');
  if (job.operation === 'start_run') {
    if (config.enabled !== true || !config.agents.includes(args.agent)) throw new Error('Remote runs disabled or agent not allowed on this Mac');
    const agent = getAgent(args.agent, ctx.root);
    if (agent.workspace === 'here') throw new Error('Remote workspace: here agents are not supported yet');
  }
  const fingerprint = createHash('sha256').update(job.operation + '\n' + JSON.stringify(job.args)).digest('hex');
  const receipt = path.join(journal, job.id + '.json');
  if (!op.read) {
    fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(receipt, JSON.stringify({ fingerprint, state: 'claimed' }), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (old.fingerprint !== fingerprint) throw new Error('Request id conflict');
      if (old.state !== 'done') throw new Error('Previous attempt interrupted; inspect local runs/reviews. It will not be executed again.');
      return old.value;
    }
  }
  let value;
  if (job.operation === 'panel_data') {
    value = dashboardData(ctx);
    value.agents = value.agents.map((a) => ({ ...a, remote_allowed: config.agents.includes(a.name) }));
    value.capabilities.run = config.enabled === true && config.agents.length > 0;
    value.relay = { online: true, enabled: config.enabled === true, agents: config.agents };
  } else if (job.operation === 'get_remote_run') {
    if (!fs.existsSync(path.join(journal, 'runs', args.run_id + '.json'))) throw new Error('Not a relay-started run');
    const r = await execute('get_run', args, { ctx });
    value = { run_id: r.run_id, agent: r.agent, status: r.status, output: r.output, error: r.error };
  } else {
    // The validated protocol names map to a small subset of the shared catalog.
    value = await execute(job.operation === 'panel_run' ? 'get_run' : job.operation, args, { ctx: { ...ctx, remote: true } });
    if (job.operation === 'start_run') save(path.join(journal, 'runs', value.run_id + '.json'), { request_id: job.id });
  }
  value = scrub(value);
  if (JSON.stringify(value).length > 230000) throw new Error('Result too large for relay; inspect it locally');
  if (!op.read) save(receipt, { fingerprint, state: 'done', value });
  return value;
}

async function post(config, route, body) {
  const r = await fetch(config.endpoint.replace(/\/$/, '') + '/relay/' + route, {
    method: 'POST', headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  if (!r.ok) throw new Error(`Relay HTTP ${r.status}`);
  return r.json();
}
export async function serveLink({ configFile = LINK_CONFIG, signal } = {}) {
  const lock = path.join(path.dirname(configFile), 'link.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) throw new Error('A relay process is already running');
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let published = 0;
  try {
    while (!signal?.aborted) {
      try {
        const config = readLink(configFile);
        const { job } = await post(config, 'poll', { enabled: config.enabled === true, agents: config.agents });
        if (job) {
          let result;
          try { result = { ok: true, value: await executeJob(job, { config: readLink(configFile) }) }; }
          catch (e) { result = { ok: false, error: e.message }; }
          // Retrying result delivery cannot repeat the operation; execution has already been journalled.
          for (let n = 0; n < 3; n++) { try { await post(config, 'complete', { id: job.id, result }); break; } catch (e) { if (n === 2) throw e; } }
        }
        if (Date.now() - published > 60000) { await publish(); published = Date.now(); }
      } catch (e) { console.error(new Date().toISOString(), e.message); }
      try { await sleep(2000, undefined, { signal }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    }
  } finally { fs.unlinkSync(lock); }
}
export async function linkMain(args) {
  const [command = 'status'] = args;
  if (command === 'serve') {
    const controller = new AbortController();
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => controller.abort());
    return serveLink({ signal: controller.signal });
  }
  if (command === 'on' || command === 'off') {
    const c = readLink(); c.enabled = command === 'on'; save(LINK_CONFIG, c);
    console.log(`Remote starts ${c.enabled ? 'enabled' : 'disabled'}; already-started runs continue.`); return;
  }
  if (command === 'status') {
    const c = readLink(); console.log(JSON.stringify({ endpoint: c.endpoint, remote_runs: c.enabled === true, allowed_agents: c.agents, mode: 'foreground' })); return;
  }
  throw new Error('Usage: agent link status|on|off|serve');
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  linkMain(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
