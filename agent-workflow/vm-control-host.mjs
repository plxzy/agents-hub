// The dok supervisor's host for VM worker control (plxzy/vm#806; contract: vm docs/AGENTS-HUB-VMSERVICE-CONTRACT.md).
//
// The Hub Worker forwards two relay operations here, `vm_control_submit` and `vm_control_get`. This file turns them into
// calls on the VmControlSupervisor and answers inside the relay's 20 s attempt window, which the helper's own 65 s call
// bound can exceed: a call that is still running when `waitMs` passes answers `{status: 'in-flight'}` and keeps running in
// this process. The caller then asks again with the SAME request key (submit) or the mutation id (get); neither can send
// a second mutation. The supervisor stays the only dispatch, dedupe, grant and polling authority; this file adds none.
//
// Nothing here reads a credential from a request. The caller's principal is asserted by the Hub Worker per entry surface
// and is only a lookup key: a grant for it must already exist (deny by default), and every door, credential and service
// pin comes from this runner's own config and enrollment, never from a request field.
import fs from 'node:fs';
import path from 'node:path';
import { FileIntentStore, StdioDoor, VmControlSupervisor } from './vm-control-supervisor.mjs';
import { VmProjectGrants } from './vm-control-grants.mjs';
import { isDefinite } from './vm-control-contract.mjs';
import { projectIntent } from './vm-control-projection.mjs';

export const WAIT_MS = 12000;
/** The relay gives a command 20 s; stay clear of it so the answer can still travel back. */
export const MAX_WAIT_MS = 15000;
const RESULT_BUDGET_BYTES = 200_000; // below the relay's 230000-byte result bound
const DOOR_REF = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_MESSAGE = /^[A-Za-z0-9 ;:.,_-]{1,180}$/;
const IN_FLIGHT = Symbol('in-flight');
const isId = v => typeof v === 'string' && v.length >= 1 && v.length <= 200;
const isRecord = v => v && typeof v === 'object' && !Array.isArray(v);

/** Validate the runner config's `vmControl` block. Unknown keys are refused so a typo cannot silently disable a gate. */
export function parseVmControlConfig(raw) {
  if (!isRecord(raw)) throw new Error('vmControl must be an object');
  const extra = Object.keys(raw).filter(k => !['owners', 'doors', 'waitMs'].includes(k));
  if (extra.length) throw new Error('vmControl has unknown members');
  if (!Array.isArray(raw.owners) || raw.owners.length < 1 || !raw.owners.every(isId)) throw new Error('vmControl.owners must list at least one owner');
  if (!isRecord(raw.doors) || !Object.keys(raw.doors).length) throw new Error('vmControl.doors must define at least one door');
  const doors = {};
  for (const [ref, door] of Object.entries(raw.doors)) {
    if (!DOOR_REF.test(ref)) throw new Error('vmControl door reference is invalid');
    if (!isRecord(door) || Object.keys(door).some(k => !['helper', 'env', 'credentialFile'].includes(k))) throw new Error('vmControl door has unknown members');
    if (![door.helper, door.credentialFile].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('vmControl door paths must be absolute');
    if (!isRecord(door.env) || Object.keys(door.env).length > 32 || !Object.values(door.env).every(v => typeof v === 'string')
      || typeof door.env.HOME !== 'string' || !path.isAbsolute(door.env.HOME)) throw new Error('vmControl door env must be strings including an absolute HOME');
    doors[ref] = { helper: door.helper, env: { ...door.env }, credentialFile: door.credentialFile };
  }
  const waitMs = raw.waitMs ?? WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > MAX_WAIT_MS) throw new Error(`vmControl.waitMs must be 1..${MAX_WAIT_MS}`);
  return { owners: [...new Set(raw.owners)], doors, waitMs };
}

function readCredential(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.mode & 0o077) throw new Error('vmControl credential file must be a private regular file');
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value || /[\s\u0000-\u001f]/.test(value)) throw new Error('vmControl credential file is empty or malformed');
  return value;
}

const rejected = error => ({ ok: false, kind: 'rejected', error });
const bareError = v => isRecord(v) && isRecord(v.error) && v.format === undefined;
const messageOf = e => (SAFE_MESSAGE.test(String(e?.message)) ? String(e.message) : 'VM control operation failed; inspect private host state');

export class VmControlHost {
  #polling = new Map(); #stopped = false;
  constructor({ supervisor, waitMs = WAIT_MS, now = Date.now, log = () => {} }) {
    this.supervisor = supervisor; this.waitMs = Math.min(waitMs, MAX_WAIT_MS); this.now = now; this.log = log;
  }

  /** Boot recovery: marks intents with no recorded reply unknown and resumes any unfinished, budget-bounded receipt polls.
   *  Reads only; it never sends. */
  start() {
    for (const id of this.supervisor.recover()) this.#poll(id);
  }
  /** Stop starting new background polls. In-flight ones are abandoned with the process; their budget is persisted. */
  stop() { this.#stopped = true; }
  /** Resolves when no background receipt poll is running (a poll queued meanwhile is awaited too). */
  async idle() { while (this.#polling.size) await Promise.all([...this.#polling.values()]); }

  #poll(id) {
    if (this.#stopped || this.#polling.has(id)) return;
    this.#polling.set(id, this.supervisor.poll(id).catch(() => this.log('VM control receipt poll failed; the persisted budget is unchanged.'))
      .finally(() => this.#polling.delete(id)));
  }
  // A reply that is not a definite service answer is read back within the persisted budget, never resent.
  #afterSubmit(response) {
    if (response?.request && !isDefinite(response)) this.#poll(response.request.mutationId);
  }
  #bounded(work) {
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(IN_FLIGHT), this.waitMs); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }
  // The contract projection plus the Hub's own display of the same intent (target label, provenance, freshness, polling).
  // The view's `evidence` repeats the response, so it is dropped; the view goes too if both could not fit the relay.
  #answer(response) {
    let view = null;
    const id = response.request?.mutationId;
    const record = id ? this.supervisor.store.get(id) : null;
    if (record) { const { evidence, ...rest } = projectIntent(record, { now: this.now(), liveEpoch: this.supervisor.epoch }); view = rest; }
    let value = { response, view };
    if (Buffer.byteLength(JSON.stringify(value)) > RESULT_BUDGET_BYTES) value = { response, view: null };
    return { ok: true, value };
  }
  #outcome(response) { return bareError(response) ? rejected(`${response.error.code}: ${response.error.detail}`.replace(/[^A-Za-z0-9 ;:.,_-]/g, ' ').slice(0, 180)) : this.#answer(response); }

  async execute(operation, args) {
    try {
      if (operation === 'vm_control_submit') {
        const work = this.supervisor.submit(args.principal, args.request_key, args.intent);
        work.then(r => this.#afterSubmit(r), () => {});
        const out = await this.#bounded(work);
        return out === IN_FLIGHT ? { ok: true, value: { status: 'in-flight', request_key: args.request_key } } : this.#outcome(out);
      }
      if (operation === 'vm_control_get') {
        if (args.refresh === true) {
          const out = await this.#bounded(this.supervisor.refresh(args.principal, args.mutation_id));
          if (out === IN_FLIGHT) return { ok: true, value: { status: 'in-flight', mutation_id: args.mutation_id } };
          if (bareError(out)) return this.#outcome(out);
        }
        return this.#outcome(this.supervisor.lookup(args.principal, args.mutation_id));
      }
      return rejected('Unknown VM control operation');
    } catch (e) { return rejected(messageOf(e)); }
  }
}

/** Build the host from the runner config's `vmControl` block. Everything durable lives under `stateDir`:
 *  `projects/` (enrollments and grants) and `intents/` (the supervisor's dispatch bookkeeping). Credentials are read once,
 *  from private files named in the config, and are held only inside each door. */
export function createVmControlHost(raw, { stateDir, log, clock, limits, now = Date.now, spawnImpl } = {}) {
  const config = parseVmControlConfig(raw);
  if (!path.isAbsolute(stateDir ?? '')) throw new Error('vmControl needs an absolute state directory');
  const doors = new Map(Object.entries(config.doors).map(([ref, d]) => [ref,
    new StdioDoor({ helper: d.helper, env: d.env, credential: readCredential(d.credentialFile), ...(spawnImpl ? { spawnImpl } : {}) })]));
  const enrollment = new VmProjectGrants({ dir: path.join(stateDir, 'projects'), owners: config.owners, now });
  const supervisor = new VmControlSupervisor({ enrollment, store: new FileIntentStore(path.join(stateDir, 'intents'), { now }),
    doors: ref => doors.get(ref), ...(clock ? { clock } : {}), ...(limits ? { limits } : {}) });
  const host = new VmControlHost({ supervisor, waitMs: config.waitMs, now, log });
  return Object.assign(host, { enrollment });
}
