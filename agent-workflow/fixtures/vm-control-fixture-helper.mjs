#!/usr/bin/env node
// Synthetic stand-in for vm's argument-less `service/vmservice-call` plus a daemon, for supervisor tests only.
// Same wire: one request line on stdin, one `{"status": N, ...}` line on stdout, exit 0 when a reply was written.
// Daemon behavior mirrored from the contract: journal-before-effect, replay of settled receipts, mutation-conflict,
// generation/backing refusal, absent receipts. State lives under $HOME/fixture; tests flip flags in $HOME/fixture/flags.
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.HOME, dir = path.join(home, 'fixture');
const stateFile = path.join(dir, 'daemon.json'), flags = path.join(dir, 'flags');
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const write = s => fs.writeFileSync(stateFile, JSON.stringify(s));
const has = name => fs.existsSync(path.join(flags, name));
const once = name => { if (!has(name)) return false; fs.unlinkSync(path.join(flags, name)); return true; };
const log = entry => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(entry) + '\n');
const out = (status, body) => process.stdout.write(`{"status": ${status}, ${JSON.stringify(body).slice(1)}\n`);
const refuse = (status, code, detail) => out(status, { error: { code, detail } });

if (process.argv.length > 2) { console.error('usage: no arguments'); process.exit(64); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
let envelope;
try { envelope = JSON.parse(input); } catch { log({ op: 'bad-json' }); refuse(400, 'bad-request', 'not JSON'); process.exit(0); }
const token = fs.readFileSync(path.join(home, '.config/vmservice-node/control.token'), 'utf8').trim();
if (envelope.authorization !== `Bearer ${token}`) { log({ op: 'unauthorized' }); refuse(403, 'unauthorized', 'bad credential'); process.exit(0); }
if (Object.keys(envelope).sort().join() !== 'authorization,body,route' || envelope.route !== 'call') { refuse(400, 'bad-request', 'envelope'); process.exit(0); }
const body = envelope.body, s = state();

if (body.operation === 'status') {
  log({ op: 'status' });
  out(200, { result: { serviceId: s.serviceId, runtime: 'container-browser' } });
  process.exit(0);
}
if (!['control-worker', 'get-control-receipt'].includes(body.operation)) { log({ op: String(body.operation) }); refuse(400, 'bad-request', 'operation'); process.exit(0); }
const fields = ['action', 'worker', 'workerGeneration', 'backingId', 'mutationId'];
if (Object.keys(body).some(k => k !== 'operation' && !fields.includes(k)) || fields.some(k => !(k in body))) {
  log({ op: body.operation, rejected: true }); refuse(400, 'bad-request', 'control fields'); process.exit(0);
}
const ACTIONS = ['backing-start', 'backing-stop', 'browser-resume', 'browser-stop', 'browser-restart'];
if (!ACTIONS.includes(body.action)) { log({ op: body.operation, rejected: true }); refuse(409, 'bad-request', 'action'); process.exit(0); }
log({ op: body.operation, action: body.action, mutationId: body.mutationId });

const fingerprint = JSON.stringify([body.action, body.worker, body.workerGeneration, body.backingId]);
const receipt = (claim, extra = {}) => ({ format: 1, serviceId: s.serviceId, worker: body.worker, workerGeneration: body.workerGeneration,
  backingId: body.backingId, action: body.action, mutationId: body.mutationId, ...extra });
const claim = s.claims[body.mutationId];
if (claim && claim.fingerprint !== fingerprint) { refuse(409, 'mutation-conflict', 'mutation id reused with a different identity'); process.exit(0); }

if (body.operation === 'get-control-receipt') {
  if (!claim) out(200, { result: receipt(null, { state: 'absent', detail: 'no claim for this intent' }) });
  else {
    if (!claim.settled) {
      // An unsettled claim: only attributable evidence (the engine acted before the crash) may confirm it.
      claim.settled = has('evidence') ? { state: 'confirmed', reconciled: true, detail: 'attributable evidence' } : { state: 'unknown', reconciled: false, detail: 'unsettled claim' };
      write(s);
    }
    out(200, { result: receipt(claim, { ...claim.settled, replayed: true }) });
  }
  process.exit(0);
}

// control-worker
if (!claim) {
  if (body.worker !== s.worker || body.workerGeneration !== s.generation) { refuse(409, 'worker-generation-mismatch', 'stale generation'); process.exit(0); }
  if (body.backingId !== s.backing) { refuse(409, 'backing-mismatch', 'stale backing'); process.exit(0); }
}
let result;
if (claim) result = receipt(claim, { ...claim.settled, replayed: true });
else {
  s.claims[body.mutationId] = { fingerprint, settled: null }; write(s);            // journal before any effect
  if (has('effect-before-crash')) { s.effects[body.action] = (s.effects[body.action] ?? 0) + 1; write(s); }  // engine acted before the crash
  if (once('crash-after-claim')) process.exit(1);                                    // unsettled claim, no reply
  const settled = has('effect-fails') ? { state: 'unknown', reconciled: false, detail: 'effect uncertain' }
    : (s.effects[body.action] = (s.effects[body.action] ?? 0) + 1, { state: 'confirmed', detail: 'done' });
  s.claims[body.mutationId].settled = settled; write(s);
  result = receipt(claim, { ...settled, replayed: false });
}
const line = `{"status": 200, ${JSON.stringify({ result }).slice(1)}\n`;
if (once('drop-reply')) process.exit(0);                                             // settled, reply lost
if (once('truncate-reply')) { process.stdout.write(line.slice(0, 40)); process.exit(0); }
if (once('oversize-reply')) { process.stdout.write('x'.repeat(4096)); process.exit(0); }
if (once('hang-after-settle')) await new Promise(r => setTimeout(r, 3600000));
process.stdout.write(line);
