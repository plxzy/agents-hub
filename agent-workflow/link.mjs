// Outbound-only relay client. Private config/journal are outside every agent's write permissions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serveSocket } from './link-socket.mjs';
import { acquireLinkLock } from './link-lock.mjs';
import { callOp, defaultContext, dashboardData } from './ops.mjs';
import { getAgent } from './agent.mjs';
import { RELAY_OPS, validateRelay } from './relay-contract.mjs';
import { containsSecret } from '../agent-readonly-service/src/snapshot.mjs';
import { fingerprintText, encode, WIRE } from './relay-wire.mjs';
import { publish } from '../agent-readonly-service/publisher.mjs';
import { doctorHealth, doctorInput } from './doctor.mjs';
import { healthLabels } from './health.mjs';

export const LINK_DIR = path.join(os.homedir(), '.config/agent-readonly');
export const LINK_CONFIG = path.join(LINK_DIR, 'link.json');
export function readLink(file = LINK_CONFIG) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^https:\/\//.test(c.endpoint) || typeof c.token !== 'string' || c.token.length < 32) throw new Error('Invalid link endpoint or credential');
  if (!Array.isArray(c.agents) || c.agents.some((a) => typeof a !== 'string')) throw new Error('Invalid remote allowlist');
  return c;
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true });
  fs.renameSync(temp, file);
  syncDirectory(path.dirname(file));
}
// Best-effort redaction supplements the agent sandbox. No raw event/transcript files cross the relay.
function scrub(value) {
  if (typeof value === 'string') return containsSecret(value) ? '[redacted: looked like a secret]' : value.length > 64000 ? value.slice(0, 64000) + '\n[truncated; full output is on the Mac]' : value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}
// One-time confirmation codes for the user's own decisions. panel_data hands them to the panel in the result's
// `_meta` (which hosts give the widget, not the model); a decision without a matching unused code is refused, even
// if a host ignored the tools' app-only visibility. In memory only: restarting `agent link serve` voids them.
const CONFIRM_TTL = 30 * 60 * 1000;
export const confirmations = new Map();
function issue(kind, target, now = Date.now()) {
  for (const [k, v] of confirmations) {
    if (v.expires < now) confirmations.delete(k);
    else if (v.kind === kind && v.target === target && v.expires - now > CONFIRM_TTL / 2) return k; // panels refresh often
  }
  const code = randomBytes(18).toString('base64url');
  confirmations.set(code, { kind, target, expires: now + CONFIRM_TTL });
  return code;
}
function redeem(code, kind, target) {
  const c = typeof code === 'string' ? confirmations.get(code) : undefined;
  if (!c || c.kind !== kind || c.target !== target || c.expires < Date.now()) {
    throw new Error('This decision needs a click in the Agents Hub panel (refresh the panel and try again).');
  }
  confirmations.delete(code);
}
// Remote tasks come from outside the Mac and their answers go back out: only agents without a shell or file-changing
// tools may be started remotely (they then also run under guards/remote.ts).
const REMOTE_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
export const remoteSafe = (agent) => Array.isArray(agent.tools) && agent.tools.every((t) => REMOTE_TOOLS.has(t));

export async function executeJob(job, { config, ctx = defaultContext(), journal = path.join(LINK_DIR, 'relay-journal'), execute = callOp } = {}) {
  validateRelay(job.operation, job.args);
  if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(job.id) || !Number.isFinite(job.expires) || job.expires <= Date.now()) throw new Error('Expired or invalid request');
  const { request_id, confirm, ...args } = job.args;
  const op = RELAY_OPS[job.operation];
  if (!op.read && request_id !== job.id) throw new Error('Request id mismatch');
  const fingerprint = createHash('sha256').update(job.operation + '\n' + JSON.stringify(job.args)).digest('hex');
  const fingerprintV2 = createHash('sha256').update(fingerprintText(job.operation, job.args)).digest('hex');
  const receipt = path.join(journal, job.id + '.json');
  if (!op.read && fs.existsSync(receipt)) {
    const old = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (old.fingerprintV2 ? old.fingerprintV2 !== fingerprintV2 : old.fingerprint !== fingerprint) throw new Error('Request id conflict (legacy receipts require original argument ordering)');
    if (!old.fingerprintV2) save(receipt, { ...old, fingerprintV2 });
    if (old.state !== 'done') throw new Error('Previous attempt interrupted; inspect local runs/reviews. It will not be executed again.');
    return old.value;
  }
  if (job.operation === 'start_run') {
    if (config.enabled !== true || !config.agents.includes(args.agent)) throw new Error('Remote runs disabled or agent not allowed on this Mac');
    const agent = getAgent(args.agent, ctx.root);
    if (agent.workspace === 'here') throw new Error('Remote workspace: here agents are not supported yet');
    if (!remoteSafe(agent)) throw new Error('Agents with a shell or file-changing tools cannot be started remotely');
  }
  if (!op.read) {
    fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
    fs.writeFileSync(receipt, JSON.stringify({ fingerprint, fingerprintV2, state: 'claimed' }), { flag: 'wx', mode: 0o600, flush: true });
    syncDirectory(journal);
  }
  try {
    if (job.operation === 'review_decide') redeem(confirm, 'review', args.id);
    if (job.operation === 'rate_run') redeem(confirm, 'rate', args.run_id);
  } catch (e) { fs.rmSync(receipt, { force: true }); throw e; } // nothing ran: this request id stays usable
  let value;
  if (job.operation === 'panel_data') {
    value = dashboardData(ctx);
    value.agents = value.agents.map((a) => ({ ...a, remote_allowed: config.agents.includes(a.name) && remoteSafe(getAgent(a.name, ctx.root)) }));
    value.confirm = {
      review: Object.fromEntries(value.pending.map((p) => [p.id, issue('review', p.id)])),
      rate: Object.fromEntries(value.runs.filter((r) => r.status !== 'running').map((r) => [r.run_id, issue('rate', r.run_id)])),
    };
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
  encode(value, WIRE.resultBytes);
  if (!op.read) save(receipt, { fingerprint, fingerprintV2, state: 'done', value });
  return value;
}

export async function serveLink({ configFile = LINK_CONFIG, signal, serve = serveSocket } = {}) {
  const release = acquireLinkLock(path.join(path.dirname(configFile), 'link.lock'));
  try {
    await serve({ readConfig: () => readLink(configFile), signal, publish,
      execute: async (job, config) => {
        try { return { ok: true, value: await executeJob(job, { config }) }; }
        catch (e) {
          const receipt = path.join(LINK_DIR, 'relay-journal', job.id + '.json');
          const interrupted = fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt, 'utf8')).state === 'claimed';
          return { ok: false, kind: interrupted ? 'interrupted' : 'rejected', error: scrub(e.message) };
        }
      },
    });
  } finally { release(); }
}

export async function serveForeground(options = {}) {
  const controller = new AbortController(), abort = () => controller.abort();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, abort);
  try { await serveLink({ ...options, signal: controller.signal }); }
  finally { for (const sig of ['SIGTERM', 'SIGINT']) process.removeListener(sig, abort); }
}

export async function linkMain(args) {
  const [command = 'status'] = args;
  if (command === 'doctor') {
    const options = args.slice(1);
    const inputIndex = options.indexOf('--input');
    const input = inputIndex < 0 ? undefined : options.splice(inputIndex, 2)[1];
    if (inputIndex >= 0 && !input || options.some((x) => x !== '--json')) throw new Error('Usage: agent link doctor [--json] [--input observations.json]');
    const report = input ? doctorInput(input) : doctorHealth({ readConfig: readLink, state: defaultContext().state, journal: path.join(LINK_DIR, 'relay-journal') });
    console.log(options.includes('--json') ? JSON.stringify(report, null, 2) : healthLabels(report).join('\n'));
    process.exitCode = report.exit_code;
    return;
  }
  if (command === 'serve') return serveForeground();
  if (command === 'on' || command === 'off') {
    const c = readLink(); c.enabled = command === 'on'; save(LINK_CONFIG, c);
    console.log(`Remote starts ${c.enabled ? 'enabled' : 'disabled'}; already-started runs continue.`); return;
  }
  if (command === 'status') {
    const c = readLink(); console.log(JSON.stringify({ endpoint: c.endpoint, remote_runs: c.enabled === true, allowed_agents: c.agents, mode: 'foreground' })); return;
  }
  throw new Error('Usage: agent link status|doctor|on|off|serve');
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  linkMain(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
