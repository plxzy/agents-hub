#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DevelopmentSessions, save } from './dev-sessions.mjs';
import { serveSocket } from './link-socket.mjs';
import { validateDevelopment } from './dev-contract.mjs';
import { fingerprintText } from './relay-wire.mjs';

const configFile = process.argv.at(-1);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (fs.statSync(configFile).mode & 0o077) throw new Error('Supervisor config must be private');
const pidFile = path.join(config.state, 'supervisor.json');
const identity = pid => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; } catch { return null; }
};
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
};
const processSession = randomUUID();
const sessions = new DevelopmentSessions({ ...config, processSession, lease, report });
// The knowledge release is frozen, so the runnable list is computed once per supervisor boot.
const agents = [...new Set(['workflow', ...sessions.runnable().map(a => a.name)])];
save(pidFile, { pid: process.pid, started: identity(process.pid), process_session: processSession });
const controller = new AbortController();
const stop = () => { sessions.stop(); controller.abort(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const journal = path.join(config.state, 'host-requests'); fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
async function execute(message) {
  const { operation, args } = message;
  try {
    validateDevelopment(operation, args, true);
    if (operation === 'dev_read') return { ok: true, value: sessions.get(args.run_id) };
    if (operation === 'run_read') return { ok: true, value: sessions.runGet(args.run_id) };
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
try {
  await serveSocket({ host: 'dok-dev', session: processSession, signal: controller.signal,
    readConfig: () => ({ endpoint: config.endpoint, token: config.token, enabled: true, agents }),
    execute, publish });
} finally {
  sessions.stop();
  for (let n = 0; n < 60 && sessions.active; n++) await new Promise(r => setTimeout(r, 100));
  sessions.active?.child?.kill('SIGKILL');
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
}
