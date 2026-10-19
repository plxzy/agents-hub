// Supervisor-owned VM worker control seam (plxzy/vm#806; contract: vm docs/AGENTS-HUB-VMSERVICE-CONTRACT.md).
//
// The supervisor freezes one authorized intent, persists it, makes ONE control call through a fixed door, and after a
// lost reply only reads the exact original receipt, within a persisted budget. vmservice stays the sole lifecycle,
// worker and history authority; this file keeps dispatch bookkeeping, not an effect journal.
//
// Four owner dependencies are injected (the contract's "Proposed owner-side integration seam"):
//   enrollment  evaluate({principal, mode: 'mutate'|'read', intent}) -> {ok, doorRef, hostId, service} | {ok:false, code, detail}
//               (VmProjectGrants in vm-control-grants.mjs is the durable provider)
//   store       durable intent store (FileIntentStore here): allocate / get / update / list / recoverable state
//   doors       doorRef -> door; door.call(body, {timeoutMs}) -> {kind:'bytes', stdout} | {kind:'failure', reason}
//   clock       {now(), sleep(ms)} plus persisted poll state, so a restart cannot reset the budget
// dev-supervisor.mjs registers it through vm-control-host.mjs when its config has `vmControl`; that host is the only caller.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { read, save } from './durable-file.mjs';
import { ContractError, FORMAT, LIMITS, daemonBody, envelopeLine, intentOf, isDefinite, parseReply, parseStrictJson,
  projectOutcome, receiptRequest, statusBody, statusServiceId, validateIntent, validateRequest, verifyReceipt } from './vm-control-contract.mjs';

const MUTATION_ID = /^vmc-[0-9a-f]{32}$/;
export const realClock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

/** Durable dispatch bookkeeping under one directory, one atomic file per intent. Holds no credential. */
export class FileIntentStore {
  constructor(dir, { now = Date.now } = {}) { this.dir = dir; this.now = now; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  file(id) { if (!MUTATION_ID.test(id)) throw new Error('invalid mutation id'); return path.join(this.dir, id + '.json'); }
  /** Allocate a fresh mutation id and persist the record built for it, before the caller may write to any door. */
  allocate(build) {
    for (;;) {
      const id = 'vmc-' + randomBytes(16).toString('hex');
      if (fs.existsSync(this.file(id))) continue;
      const record = build(id);
      save(this.file(id), record);
      return structuredClone(record);
    }
  }
  get(id) { try { return read(this.file(id)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  /** Synchronous read-modify-write, so concurrent callers in one process cannot interleave. */
  update(id, mutate) { const record = read(this.file(id)); mutate(record); record.updatedAt = this.now(); save(this.file(id), record); return record; }
  list() { return fs.readdirSync(this.dir).filter(f => /^vmc-[0-9a-f]{32}\.json$/.test(f)).sort().map(f => read(path.join(this.dir, f))); }
  /** The only handle the Hub projection receives. */
  readOnly() { return Object.freeze({ get: id => this.get(id), list: () => this.list() }); }
}

/** The one fixed door: the argument-less helper, a trusted environment and a supervisor-held credential. The credential
 *  goes to the helper's stdin only; stderr is discarded; a deadline or overflow kills only the helper's process group. */
export class StdioDoor {
  #credential;
  constructor({ helper, env, credential, limits = {}, spawnImpl = spawn }) {
    if (!path.isAbsolute(helper)) throw new Error('the helper must be an absolute path');
    this.helper = helper; this.env = Object.freeze({ ...env }); this.#credential = credential; this.spawnImpl = spawnImpl;
    this.stdoutBytes = Math.min(limits.stdoutBytes ?? LIMITS.stdoutBytes, LIMITS.stdoutBytes);
  }
  call(body, { timeoutMs = LIMITS.helperMs } = {}) {
    const timeout = Math.min(timeoutMs, LIMITS.helperMs);
    const line = envelopeLine(`Bearer ${this.#credential}`, body);
    return new Promise(resolve => {
      let child;
      try { child = this.spawnImpl(this.helper, [], { env: this.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { return resolve({ kind: 'failure', reason: 'spawn' }); }
      const chunks = []; let size = 0, done = false;
      const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
      const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
      const timer = setTimeout(() => { killGroup(); finish({ kind: 'failure', reason: 'timeout' }); }, timeout);
      child.on('error', () => finish({ kind: 'failure', reason: 'spawn' }));
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > this.stdoutBytes) { killGroup(); finish({ kind: 'failure', reason: 'overflow' }); } else chunks.push(chunk);
      });
      child.on('close', code => finish(code === 0 ? { kind: 'bytes', stdout: Buffer.concat(chunks) } : { kind: 'failure', reason: 'exit' }));
      child.stdin.end(line);
    });
  }
}

const REASONS = { timeout: 'no complete reply before the deadline', overflow: 'reply exceeded the output bound', exit: 'the helper exited without a complete reply',
  spawn: 'the helper could not be run' };
const nowRecord = (clock, via, response) => ({ via, at: clock.now(), state: response.state, source: response.source, reply: response.reply, error: response.error });

export class VmControlSupervisor {
  #active = new Set(); #recovered = false; #inflight = new Map();
  constructor({ enrollment, store, doors, clock = realClock, limits = {}, epoch = randomUUID() }) {
    this.enrollment = enrollment; this.store = store; this.doors = doors; this.clock = clock; this.epoch = epoch;
    this.limits = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, Math.min(limits[k] ?? v, v)]));
  }

  // One exchange through the door. Never throws: any unusable reply is a transport-level unknown.
  async #exchange(door, request, timeoutMs) {
    let result;
    try { result = await door.call(daemonBody(request), { timeoutMs }); } catch { return { kind: 'transport', detail: REASONS.spawn }; }
    if (result.kind !== 'bytes') return { kind: 'transport', detail: REASONS[result.reason] ?? 'no reply' };
    try {
      const parsed = parseReply(result.stdout);
      verifyReceipt(request, parsed);
      return { kind: 'reply', reply: parsed };
    } catch (e) { return { kind: 'transport', detail: e instanceof ContractError ? e.detail : 'unusable reply' }; }
  }
  // Read-only identity check through the same door: the enrolled service pin must equal status.serviceId.
  async #identity(door, service, timeoutMs) {
    let result;
    try { result = await door.call(statusBody(), { timeoutMs }); } catch { return 'unavailable'; }
    if (result.kind !== 'bytes') return 'unavailable';
    try { return statusServiceId(parseReply(result.stdout, 'status')) === service ? 'ok' : 'mismatch'; } catch { return 'unavailable'; }
  }
  #door(verdict) { return this.doors(verdict.doorRef) ?? null; }
  #settles(kind, response) {
    return isDefinite(response) && (kind === 'control' || response.reply.status === 200);
  }
  #record(id, kind, response) {
    // Settlement is sticky: a settled receipt replays and never changes, so a later failed read cannot erase or replace it.
    this.store.update(id, r => {
      const entry = nowRecord(this.clock, kind, response);
      r.latest = entry;
      if (response.reply?.status === 200) r.evidence = entry;
      if (!r.settled && this.#settles(kind, response)) r.settled = entry;
      if (kind === 'control') r.phase = 'settled';
    });
  }

  /** Submit one explicit authorized intent under a caller-supplied `requestKey` (1..200 chars, one per user action).
   *  The key is deduplicated per (principal, projectId, key) for the lifetime of the persisted intent record: the same
   *  key with the same canonical intent returns that intent's projection and sends nothing; the same key with a different
   *  intent is `request-key-conflict`. If records are ever deleted, key reuse then needs its own policy. A fresh action
   *  needs a new key. Input is an intent (object or JSON text): the full request without `kind` and `mutationId`.
   *  Returns the contract projection, a bare bad-request error, or an admission refusal (no mutation id exists yet, so
   *  `request` is null, as the contract permits for admission refusals of a new submission only). */
  async submit(principal, requestKey, input) {
    if (typeof requestKey !== 'string' || requestKey.length < 1 || requestKey.length > 200) return { error: { code: 'bad-request', detail: 'requestKey is a 1..200 character string' } };
    let intent;
    try { intent = validateIntent(typeof input === 'string' ? parseStrictJson(input) : input); }
    catch (e) { return { error: { code: 'bad-request', detail: e.detail ?? 'invalid request' } }; }
    const refuse = (code, detail) => ({ format: FORMAT, request: null, state: 'refused', source: 'admission', reply: null, error: { code, detail } });
    // Canonical persisted form: validateIntent rebuilds members in a fixed order, so caller key order cannot matter.
    const canon = JSON.stringify(intent), scope = JSON.stringify([principal, intent.projectId, requestKey]);
    const conflict = () => refuse('request-key-conflict', 'this request key was used for a different intent');
    // Claim the key synchronously, before any await, so concurrent duplicates cannot both dispatch.
    const running = this.#inflight.get(scope);
    if (running) return running.canon === canon ? running.promise : conflict();
    const known = this.store.list().find(r => r.keyScope === scope);
    if (known) return known.intentCanon === canon ? this.#duplicate(principal, known, intent, refuse) : conflict();
    const promise = this.#send(principal, intent, canon, scope, refuse);
    this.#inflight.set(scope, { canon, promise });
    try { return await promise; } finally { this.#inflight.delete(scope); }
  }
  // A duplicate is a read of the existing intent: it needs the read grant, and sends nothing.
  #duplicate(principal, existing, intent, refuse) {
    const verdict = this.enrollment.evaluate({ principal, mode: 'read', intent });
    return verdict.ok ? this.response(existing.request.mutationId) : refuse(verdict.code, verdict.detail);
  }
  async #send(principal, intent, canon, scope, refuse) {
    const verdict = this.enrollment.evaluate({ principal, mode: 'mutate', intent });
    if (!verdict.ok) return refuse(verdict.code, verdict.detail);
    const door = this.#door(verdict);
    if (!door) return refuse('door-unavailable', 'no fixed door is configured for this enrollment');
    const pin = await this.#identity(door, verdict.service, this.limits.helperMs);
    if (pin === 'mismatch') return refuse('identity-mismatch', 'the door reports a different service identity');
    if (pin === 'unavailable') return refuse('identity-unverified', 'the service identity could not be verified; nothing was sent');
    // Persist the immutable tuple, operation and target BEFORE anything is written to the door.
    let request;
    this.store.allocate(id => {
      request = validateRequest({ ...intent, kind: 'control', hostId: verdict.hostId, service: verdict.service, mutationId: id });
      return { format: 1, request, principal, keyScope: scope, intentCanon: canon, epoch: this.epoch, createdAt: this.clock.now(), phase: 'sending', latest: null, evidence: null, settled: null,
        poll: { attempts: 0, batchStartedAt: null, batchDeadline: null, lastCompletedAt: null, active: null, exhausted: false } };
    });
    const outcome = await this.#exchange(door, request, this.limits.helperMs);
    this.#record(request.mutationId, 'control', projectOutcome(request, outcome));
    return this.response(request.mutationId);
  }

  /** The contract projection of an intent as currently known: settled evidence wins; otherwise the latest attempt. */
  response(id) {
    const r = this.store.get(id);
    if (!r) return null;
    const current = r.settled ?? r.latest ?? { state: 'unknown', source: 'transport', reply: null,
      error: { code: 'reply-unavailable', detail: 'supervisor restarted before a reply was recorded' } };
    return { format: FORMAT, request: r.request, state: current.state, source: current.source, reply: current.reply, error: current.error };
  }

  /** A restart cannot reset anything: intents with no recorded reply become unknown, active batches are released, and
   *  consumed attempts and deadlines stay as persisted. Never sends. Returns ids still needing receipt polls. */
  recover() {
    for (const r of this.store.list()) {
      if (r.poll.active && r.poll.active !== this.epoch) this.store.update(r.request.mutationId, x => { x.poll.active = null; });
      if (r.phase === 'sending' && r.epoch !== this.epoch) {
        this.store.update(r.request.mutationId, x => {
          x.phase = 'recovered';
          x.latest ??= { via: 'recovery', at: this.clock.now(), state: 'unknown', source: 'transport', reply: null,
            error: { code: 'reply-unavailable', detail: 'supervisor restarted before a reply was recorded' } };
        });
      }
    }
    this.#recovered = true;
    return this.store.list().filter(r => !r.settled && !r.poll.exhausted).map(r => r.request.mutationId);
  }

  async #receiptRead(door, record, timeoutMs) {
    const request = receiptRequest(record.request);
    const pin = await this.#identity(door, request.service, timeoutMs);
    if (pin !== 'ok') return projectOutcome(request, { kind: 'transport', detail: pin === 'mismatch' ? 'the door reports a different service identity' : 'the service identity could not be verified' });
    return projectOutcome(request, await this.#exchange(door, request, timeoutMs));
  }
  #readDoor(record) {
    const verdict = this.enrollment.evaluate({ principal: record.principal, mode: 'read', intent: intentOf(record.request) });
    return verdict.ok ? { verdict, door: this.#door(verdict) } : { denied: verdict };
  }

  /** The automatic bounded receipt batch: at most 3 reads, >=5 s apart, 210 s wall clock, all persisted. Reads only. */
  async poll(id) {
    if (!this.#recovered) this.recover();
    const first = this.store.get(id);
    if (!first) throw new Error('unknown intent');
    if (first.settled) return { status: 'settled', attempts: first.poll.attempts };
    if (this.#active.has(id)) return { status: 'already-running', attempts: first.poll.attempts };
    const access = this.#readDoor(first);
    if (access.denied) return { status: 'denied', attempts: first.poll.attempts, error: { code: access.denied.code, detail: access.denied.detail } };
    if (!access.door) return { status: 'denied', attempts: first.poll.attempts, error: { code: 'door-unavailable', detail: 'no fixed door is configured' } };
    this.#active.add(id);
    try {
      for (;;) {
        let r = this.store.get(id);
        if (r.settled) return { status: 'settled', attempts: r.poll.attempts };
        let now = this.clock.now();
        const deadline = r.poll.batchDeadline ?? now + this.limits.batchMs;
        const exhaust = () => { this.store.update(id, x => { x.poll.exhausted = true; x.poll.active = null; }); return { status: 'exhausted', attempts: r.poll.attempts }; };
        if (r.poll.attempts >= this.limits.polls || now >= deadline) return exhaust();
        if (r.poll.lastCompletedAt !== null) {
          const wait = r.poll.lastCompletedAt + this.limits.pollGapMs - now;
          if (wait > 0) {
            if (now + wait >= deadline) return exhaust();
            await this.clock.sleep(wait);
            now = this.clock.now();
          }
        }
        // The attempt and its deadline are durable BEFORE the helper runs, so a crash mid-read still consumes it.
        r = this.store.update(id, x => { x.poll.attempts++; x.poll.batchStartedAt ??= now; x.poll.batchDeadline ??= now + this.limits.batchMs; x.poll.active = this.epoch; });
        const response = await this.#receiptRead(access.door, r, Math.min(this.limits.helperMs, Math.max(1, r.poll.batchDeadline - now)));
        this.#record(id, 'receipt', response);
        this.store.update(id, x => { x.poll.lastCompletedAt = this.clock.now(); x.poll.active = null; });
      }
    } finally { this.#active.delete(id); }
  }
  async pollUnresolved() { return Promise.all(this.recover().map(id => this.poll(id).then(result => [id, result]))); }

  /** One explicit, authorized receipt read. It is not an automatic loop and does not touch the poll budget. */
  async refresh(principal, id) {
    if (!this.#recovered) this.recover();
    const r = this.store.get(id);
    if (!r || r.principal !== principal) return { error: { code: 'bad-request', detail: 'unknown intent' } };
    const access = this.#readDoor(r);
    if (access.denied || !access.door) {
      const e = access.denied ?? { code: 'door-unavailable', detail: 'no fixed door is configured' };
      return projectOutcome(receiptRequest(r.request), { kind: 'admission', code: e.code, detail: e.detail });
    }
    const response = await this.#receiptRead(access.door, r, this.limits.helperMs);
    this.#record(id, 'receipt', response);
    return response;
  }

  /** An authorized read of the supervisor's own record: needs the intent's principal and a valid read grant, contacts no
   *  service and spawns nothing. Returns the contract projection, or the admission refusal of a receipt read. */
  lookup(principal, id) {
    const r = typeof id === 'string' && MUTATION_ID.test(id) ? this.store.get(id) : null;
    if (!r || r.principal !== principal) return { error: { code: 'bad-request', detail: 'unknown intent' } };
    const verdict = this.enrollment.evaluate({ principal, mode: 'read', intent: intentOf(r.request) });
    if (!verdict.ok) return projectOutcome(receiptRequest(r.request), { kind: 'admission', code: verdict.code, detail: verdict.detail });
    return this.response(id);
  }
}
