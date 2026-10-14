#!/usr/bin/env node
import { prepareReviewBase } from './review-base.mjs';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DevelopmentSessions, save } from './dev-sessions.mjs';
import { serveSocket } from './link-socket.mjs';
import { validateDevelopment } from './dev-contract.mjs';
import { fingerprintText } from './relay-wire.mjs';
import { publishArtifact } from './run-artifact.mjs';

const configFile = process.argv.at(-1);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (fs.statSync(configFile).mode & 0o077) throw new Error('Supervisor config must be private');
const pidFile = path.join(config.state, 'supervisor.json');
const identity = pid => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; } catch { return null; }
};
const controlPath = path.join(config.state, 'control.sock');
async function control(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPath); let data = '';
    socket.setTimeout(3000, () => socket.destroy(Error('Supervisor control timed out')));
    socket.on('connect', () => socket.end(command)); socket.on('data', b => { data += b; });
    socket.on('error', reject); socket.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
}
if (process.argv.includes('--drain')) {
  let status = await control('drain');
  for (let n = 0; !status.idle && n < 60; n++) { await new Promise(r => setTimeout(r, 1000)); status = await control('status'); }
  if (!status.idle) { await control('undrain'); throw Error('Active work remains; deployment restart refused'); }
  console.log('Runner drained and idle'); process.exit(0);
}
if (process.argv.includes('--undrain')) { await control('undrain'); process.exit(0); }
if (process.argv.includes('--stop')) {
  if (fs.existsSync(pidFile)) {
    const { pid, started } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (identity(pid) === started) {
      process.kill(pid, 'SIGTERM');
      for (let n = 0; n < 100 && identity(pid) === started; n++) await new Promise(r => setTimeout(r, 100));
      if (identity(pid) === started) process.kill(pid, 'SIGKILL');
    }
  }
  process.exit(0);
}
if (fs.existsSync(pidFile)) {
  const previous = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  if (identity(previous.pid) === previous.started) throw new Error('Supervisor already running');
}
const endpoint = new URL(config.endpoint);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw new Error('Invalid Hub endpoint');
const lease = async args => {
  const response = await fetch(new URL('/relay/dok-dev/lease', endpoint), { method: 'POST',
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    body: JSON.stringify(args), redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Execution authority unavailable');
  const value = await response.json();
  if (value.authorized && (value.grant_id !== args.grant_id || value.policy_digest !== args.policy_digest)) throw new Error('Execution lease mismatch');
  return value;
};
// Run receipts go to the Hub (D1) so results stay readable when this host or the socket is down.
const report = async receipt => {
  const response = await fetch(new URL('/relay/dok-dev/runs', endpoint), { method: 'POST',
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    body: JSON.stringify(receipt), redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Receipt not accepted');
  if (config.runArtifacts !== false && receipt.status === 'completed' && receipt.review_ref) {
    await publishArtifact(receipt, { state: config.state, repository: sessions.repos[receipt.repo], config });
  }
};
const hub = async (route, init = {}) => {
  const response = await fetch(new URL(route, endpoint), { ...init, headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Hub refused');
  return response.json();
};
const accounts = { get: async () => (await hub('/relay/dok-dev/accounts')).accounts,
  post: value => hub('/relay/dok-dev/accounts', { method: 'POST', body: JSON.stringify(value) }) };
// Definitions, skills and accepted memory come from the Hub per run. At boot the published agent list is written
// to a folder so the runnable set follows the Hub; if the Hub is unreachable the frozen release is used.
const knowledgeHub = async name => hub('/relay/dok-dev/knowledge?agent=' + encodeURIComponent(name));
let hubAgents = null;
try {
  const published = await hub('/relay/dok-dev/knowledge');
  const dir = path.join(config.state, 'hub-knowledge');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'agents'), { recursive: true, mode: 0o700 });
  let count = 0;
  for (const [name, text] of Object.entries(published.files ?? {})) {
    if (!/^agents\/[a-z0-9][a-z0-9_-]{0,63}\.md$/.test(name) || typeof text !== 'string') continue;
    fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 }); count++;
  }
  if (count) hubAgents = dir;
} catch { /* frozen release */ }
const processSession = randomUUID();
const sessions = new DevelopmentSessions({ ...config, processSession, lease, report, accounts, knowledgeHub,
  prepareReview: config.reviewPublisher ? (repo, id, selection) => config.reviewPublisher.repositories.includes(repo)
    ? prepareReviewBase(config.reviewPublisher.socket, repo, id, selection) : null : null,
  prepareBase: config.reviewPublisher ? (repo, id) => config.reviewPublisher.repositories.includes(repo)
    ? prepareReviewBase(config.reviewPublisher.socket, repo, id) : null : null, hub_agents: hubAgents });
// The knowledge release is frozen, so the runnable list is computed once per supervisor boot.
const agents = [...new Set(['workflow', ...sessions.runnable().map(a => a.name)])];
const started = identity(process.pid);
save(pidFile, { pid: process.pid, started, process_session: processSession });
const healthFile = path.join(config.state, 'supervisor-health.json');
const health = { schema_version: 1, pid: process.pid, started, process_session: processSession,
  hub_ready: false, last_pong_at: null, fatal: false, updated_at: new Date().toISOString() };
const writeHealth = patch => save(healthFile, Object.assign(health, patch, { updated_at: new Date().toISOString() }));
writeHealth({});
const controller = new AbortController();
const stop = () => { sessions.stop(); controller.abort(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const journal = path.join(config.state, 'host-requests'); fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
async function execute(message) {
  const { operation, args } = message;
  try {
    validateDevelopment(operation, args, true);
    if (operation === 'dev_read') return { ok: true, value: sessions.get(args.run_id) };
    if (operation === 'run_lookup') return { ok: true, value: sessions.runLookup(args.target_request_id) };
    if (operation === 'run_read') return { ok: true, value: sessions.runGet(args.run_id) };
    if (operation === 'run_resume') return { ok: true, value: await sessions.resumeRun(args, { approved: args.approved === true }) };
    if (operation === 'run_start') return { ok: true, value: await sessions.runStart(args) };
    if (operation === 'dev_start') return { ok: true, value: await sessions.start(args) };
    const file = path.join(journal, args.request_id + '.json'), fp = fingerprintText(operation, args);
    if (fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (old.fingerprint !== fp) throw new Error('Request identity conflict');
      if (old.value) return { ok: true, value: old.value };
      throw new Error('Interrupted operation; inspect host state before submitting a new request');
    }
    save(file, { fingerprint: fp });
    const value = operation === 'dev_prepare' ? await sessions.prepare(args) : await sessions.export(args);
    save(file, { fingerprint: fp, value });
    return { ok: true, value };
  } catch (error) {
    // Only bounded, known operational messages cross the relay; never stacks/commands.
    const message = String(error.message);
    return { ok: false, kind: 'rejected', error: /^[A-Za-z0-9 ;:.,_-]{1,180}$/.test(message) ? message : 'Development operation failed; inspect private host state' };
  }
}
async function publish() {
  await sessions.recoverPending();
  await sessions.flushReports();
  await acknowledgeStopped();
}
async function acknowledgeStopped() {
  for (const file of fs.readdirSync(path.join(config.state, 'runs'))) {
    const r = JSON.parse(fs.readFileSync(path.join(config.state, 'runs', file), 'utf8'));
    if (r.status === 'running' || sessions.active?.grant_id === r.grant_id) continue;
    try { await lease({ grant_id: r.grant_id, process_session: r.manifest.process_session, policy_digest: r.manifest.policy_digest, execution_state: 'stopped' }); }
    catch { return; }
  }
}
// Private local control only. The drained admission flag and active count belong to this process.
try { fs.unlinkSync(controlPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const controlServer = net.createServer({ allowHalfOpen: true }, socket => {
  let request = '';
  socket.on('data', b => { request += b; if (request.length > 32) socket.destroy(); });
  socket.on('error', () => {});
  socket.on('end', () => {
    if (request === 'drain') sessions.draining = true;
    else if (request === 'undrain') sessions.draining = false;
    socket.end(JSON.stringify({ idle: !sessions.active && sessions.runs.size === 0 && !sessions.preparingStarts && !sessions.recoveryScanning, draining: sessions.draining === true }));
  });
});
await new Promise((resolve, reject) => { controlServer.once('error', reject); controlServer.listen(controlPath, resolve); });
fs.chmodSync(controlPath, 0o600);
try {
  await serveSocket({ host: 'dok-dev', session: processSession, signal: controller.signal,
    readConfig: () => ({ endpoint: config.endpoint, token: config.token, enabled: !sessions.draining, agents, run_selection: sessions.runSelection() }),
    execute, publish,
    onState: ({ hub_ready, last_pong_at, fatal }) => writeHealth({ hub_ready: hub_ready === true,
      last_pong_at: last_pong_at ?? null, fatal: fatal === true }) });
} finally {
  sessions.stop();
  for (let n = 0; n < 60 && (sessions.active || sessions.runs.size || sessions.preparingStarts); n++) await new Promise(r => setTimeout(r, 100));
  sessions.active?.child?.kill('SIGKILL');
  controlServer.close();
  try { fs.unlinkSync(controlPath); } catch {}
  writeHealth({ hub_ready: false, last_pong_at: null, fatal: false });
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
}
