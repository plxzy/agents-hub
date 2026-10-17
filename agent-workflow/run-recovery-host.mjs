import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { save, read } from './durable-file.mjs';
import { loadCheckpoint, recoveryState, fingerprint } from './run-recovery.mjs';
import { publicRecovery, recoveryEligible } from './recovery-contract.mjs';
import { newId } from './agent.mjs';
import { sanitizeFailureContext } from './failure-telemetry.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const runId = id => /^r-\d{8}T\d{6}Z-[a-f0-9]{6}$/.test(id ?? '');
const requestId = id => /^[A-Za-z0-9_-]{8,80}$/.test(id ?? '');
const safeText = text => sanitizeFailureContext({ message: text })?.message ?? '';
export const CONTROL = ['cancel', 'pause', 'dismiss', 'retry_inspection'];
// The reason becomes part of the public recovery reason, which allows only this character set.
export const CONTROL_REASON = /^[A-Za-z0-9 ;:.,_-]{0,120}$/;
const controlView = r => {
  const recovery = publicRecovery(r.recovery);
  if (recovery) delete recovery.inspection;
  return { status: r.status, ...(recovery ? { recovery } : {}) };
};
export class RecoveryHost {
  recoveryDir(id) {
    if (!runId(id)) throw Error('Invalid run');
    return path.join(this.state, 'recovery-v1', id);
  }
  recoveryInfo(id) {
    const dir = this.recoveryDir(id);
    try {
      const setup = read(path.join(dir, 'setup.json'));
      let checkpoint;
      try { checkpoint = loadCheckpoint(path.join(dir, 'checkpoint.json')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; if (setup.config.recover_from) checkpoint = loadCheckpoint(setup.config.recover_from); }
      const lifecycle = fs.existsSync(path.join(dir, 'lifecycle.json')) ? read(path.join(dir, 'lifecycle.json')) : {};
      const receipt = read(path.join(this.state, 'agent-runs', id + '.json'));
      let state = checkpoint ? recoveryState(checkpoint) : 'paused';
      let reason = checkpoint ? undefined : 'No durable child checkpoint; retained work requires inspection';
      if (receipt.status === 'failed' && !recoveryEligible(receipt)) { state = 'paused'; reason = 'Failure requires operator inspection before recovery'; }
      if (!fs.existsSync(setup.config.policy.workspace)) { state = 'paused'; reason = 'Recovery workspace unavailable'; }
      if (checkpoint && lifecycle.retry_reason) reason = lifecycle.retry_reason;
      if (lifecycle.inspection_error) reason = lifecycle.inspection_error;
      if (state === 'ready' && (setup.attempt ?? 0) >= 2) { state = 'paused'; reason = 'Automatic recovery attempt limit reached'; }
      if (checkpoint?.remaining_ms <= 1000) { state = 'paused'; reason = 'Run execution budget exhausted'; }
      if (setup.revision !== this.revision) { state = 'paused'; reason = 'Runner release changed; operator migration required'; }
      if (lifecycle.paused) { state = 'paused'; reason = lifecycle.paused; }
      if (lifecycle.held && state === 'ready') reason = lifecycle.held;
      if (lifecycle.dismissed) { state = 'dismissed'; reason = lifecycle.dismissed; }
      if (lifecycle.resumed_by) state = 'resumed';
      if (receipt.status === 'completed') state = 'completed';
      const info = publicRecovery({ state, reason, checkpoint_version: checkpoint?.version, checkpoint_at: checkpoint?.saved_at,
        failed_resume_supported: true,
        retained: fs.existsSync(setup.config.policy.workspace), resumed_from: receipt.recovery?.resumed_from,
        resumed_by: lifecycle.resumed_by, inspection: lifecycle.inspection });
      return { setup, checkpoint, lifecycle, info };
    } catch {
      let retained = fs.existsSync(dir), dismissed;
      try { dismissed = read(path.join(dir, 'lifecycle.json')).dismissed; } catch { /* no operator decision recorded */ }
      if (dismissed) return { info: { state: 'dismissed', retained, reason: dismissed } };
      try { const r = read(path.join(this.state, 'agent-runs', id + '.json')); retained ||= fs.existsSync(path.join(this.state, 'run-work', r.root ?? id)); } catch {}
      return { info: { state: 'unavailable', retained, reason: 'Recovery checkpoint unavailable or invalid; preserve retained artifacts' } };
    }
  }
  saveRecoveryInfo(id, info) {
    const file = path.join(this.state, 'agent-runs', id + '.json'), r = read(file);
    let partial = {};
    if (r.status === 'interrupted' && !r.output) {
      const cp = this.recoveryInfo(id).checkpoint;
      if (cp?.partial) partial = { output: safeText(cp.partial.output), output_partial: true,
        failure_context: sanitizeFailureContext(cp.partial.failure_context) };
    }
    const before = { ...r.recovery }; delete before.revision;
    if (JSON.stringify(before) === JSON.stringify(info) && !Object.keys(partial).length) return;
    save(file, { ...r, ...partial, recovery: { ...info, revision: (r.recovery?.revision ?? 0) + 1 }, reported_at: undefined });
  }
  async recoverPending() {
    if (!this.limits.autoRecovery || this.draining || this.recoveryScanning) return;
    this.recoveryScanning = true;
    try {
      for (const name of fs.readdirSync(path.join(this.state, 'agent-runs'))) {
        let r; try { r = read(path.join(this.state, 'agent-runs', name)); } catch { continue; }
        if (!recoveryEligible(r) || this.runs.has(r.run_id)) continue;
        const value = this.recoveryInfo(r.run_id);
        this.saveRecoveryInfo(r.run_id, value.info);
        // Old failed runs are preserved for explicit selection, never revived by an upgrade.
        if (r.status === 'failed' && value.lifecycle?.automatic_eligible !== true) continue;
        if (value.lifecycle?.held) continue; // paused by an operator: only an explicit resume_run continues it
        if (value.info.state === 'awaiting_review' && !value.lifecycle.inspection_started) await this.inspectRecovery(r, value);
        else if (value.info.state === 'ready') {
          try { await this.resumeRun({ run_id: r.run_id, request_id: `recover-${r.run_id}-${value.checkpoint.version}`,
            checkpoint_version: value.checkpoint.version }, { automatic: true }); }
          catch (e) {
            // Capacity is transient. Other blockers need a visible, durable explanation.
            if (!/busy|draining/.test(e.message)) {
              const transient = /account|limit until/i.test(e.message);
              save(path.join(this.recoveryDir(r.run_id), 'lifecycle.json'), { ...value.lifecycle, [transient ? 'retry_reason' : 'paused']: safeText(e.message) });
              this.saveRecoveryInfo(r.run_id, this.recoveryInfo(r.run_id).info);
            }
          }
        }
      }
    } finally { this.recoveryScanning = false; }
  }
  async resumeRun({ run_id, request_id, checkpoint_version }, { approved = false, automatic = false } = {}) {
    if (!runId(run_id) || !requestId(request_id) || !Number.isSafeInteger(checkpoint_version) || checkpoint_version < 1) throw Error('Invalid recovery request');
    const request = path.join(this.state, 'agent-requests', request_id + '.json');
    const fp = fingerprint({ operation: 'resume', run_id, checkpoint_version });
    if (fs.existsSync(request)) {
      const old = read(request);
      if (old.fingerprint !== fp) throw Error('Request identity conflict');
      return this.runGet(old.run_id);
    }
    if (this.draining) throw Error('Runner draining; retry when available');
    const previous = read(path.join(this.state, 'agent-runs', run_id + '.json'));
    const recovery = this.recoveryInfo(run_id), { setup, checkpoint, info } = recovery;
    if (info.state === 'resumed') return this.runGet(info.resumed_by);
    if (!recoveryEligible(previous)) throw Error('Failure requires operator inspection before recovery');
    if (!checkpoint || checkpoint.version !== checkpoint_version) throw Error('Recovery checkpoint changed; refresh the run');
    if (automatic && previous.status === 'failed' && recovery.lifecycle.automatic_eligible !== true) throw Error('Historical failed run requires explicit recovery selection');
    // Safety invariants cannot depend on which blocker the UI happens to display.
    if (setup.revision !== this.revision) throw Error('Runner release changed; operator migration required');
    if (checkpoint.remaining_ms <= 1000) throw Error('Run execution budget exhausted');
    if (automatic && (setup.attempt ?? 0) >= 2) throw Error('Automatic recovery attempt limit reached');
    if (!['ready', 'awaiting_review'].includes(info.state) && !(info.state === 'paused' && info.reason === 'Automatic recovery attempt limit reached' && !automatic)) throw Error(info.reason ?? 'Run cannot resume');
    if (recoveryState(checkpoint) === 'awaiting_review' && (!approved || !recovery.lifecycle.inspection)) throw Error('Interrupted command requires recovery review');
    const live = this.runnable().find(a => a.name === previous.agent);
    if (!live || live.version !== setup.agent.version) throw Error('Agent definition changed; operator migration required');
    if (!info.retained) throw Error('Recovery workspace unavailable');
    const active = [...this.runs.values()];
    if (active.some(r => r.repo === previous.repo) || active.filter(r => r.write === previous.write).length >= (previous.write ? this.limits.writeRuns : this.limits.runs)) throw Error('Recovery repository or capacity is busy');
    this.room();
    const next = newId('r'), entry = { write: previous.write, repo: previous.repo };
    this.runs.set(next, entry); // reserve before any await, including account lookup
    try {
      const provider = checkpoint.runtime?.provider ?? (Object.keys(checkpoint.tools).length === 0 ? setup.config.slots?.[0] : undefined);
      if (this.knowledgeHub && setup.receipt.memory_hash) {
        const kb = await this.knowledgeHub(previous.agent);
        if (kb?.hash !== setup.receipt.memory_hash) throw Error('Agent knowledge changed; operator migration required');
      }
      const finished = checkpoint.result && !checkpoint.result.error;
      const slots = finished ? setup.config.slots : setup.runtime.provider === 'openai' ? await this.poolSlots() : [setup.runtime.provider];
      if (!provider || !slots.includes(provider)) throw Error('Recovery account unavailable; retry later');
      if (entry.stopped || this.draining) throw Error('Runner draining; retry when available');
      const receipt = { ...setup.receipt, run_id: next, request_id, started: new Date().toISOString(), status: 'running',
        recovery: { state: 'ready', retained: true, resumed_from: run_id },
        root: previous.root, progress: { phase: 'startup', action: 'preparing', observed_at: new Date().toISOString() } };
      const dir = this.recoveryDir(next); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const config = { ...setup.config, slots: [provider], recover_from: path.join(this.recoveryDir(run_id), 'checkpoint.json'),
        checkpoint_file: path.join(dir, 'checkpoint.json'), remaining_ms: Math.max(0, checkpoint.remaining_ms - 1000), recovery_approved: approved,
        manifest: { ...setup.config.manifest, run_id: next } };
      const nextSetup = { ...setup, receipt, config, attempt: (setup.attempt ?? 0) + 1, automatic, request_fingerprint: fp };
      save(path.join(dir, 'setup.json'), nextSetup);
      // The request contains the reserved receipt, so a death between the two writes cannot lose its identity.
      save(path.join(this.recoveryDir(run_id), 'lifecycle.json'), { ...recovery.lifecycle, resumed_by: next });
      save(request, { fingerprint: fp, run_id: next, receipt });
      save(path.join(this.state, 'agent-runs', next + '.json'), receipt);
      this.saveRecoveryInfo(run_id, { ...info, state: 'resumed', resumed_by: next });
      void this.report(run_id); void this.report(next);
      void this.executeRun(setup.agent, setup.runtime, receipt, null, { setup: nextSetup, checkpoint }).catch(() => this.finalizationFailed(receipt));
      return this.runGet(next);
    } catch (e) { this.runs.delete(next); throw e; }
  }
  // Operator actions on one run. Each is idempotent per request_id and returns the run's state before and after.
  async controlRun({ run_id, request_id, action, reason = '' }) {
    if (!runId(run_id) || !requestId(request_id) || !CONTROL.includes(action) || !CONTROL_REASON.test(reason)) throw Error('Invalid run action');
    const request = path.join(this.state, 'agent-requests', request_id + '.json');
    const fp = fingerprint({ operation: 'control', run_id, action, reason });
    if (fs.existsSync(request)) {
      const old = read(request);
      if (old.fingerprint !== fp) throw Error('Request identity conflict');
      return old.value;
    }
    const file = path.join(this.state, 'agent-runs', run_id + '.json');
    if (!fs.existsSync(file)) throw Error('Unknown run');
    const r = read(file), entry = this.runs.get(run_id), before = controlView(r);
    const dir = this.recoveryDir(run_id), lifeFile = path.join(dir, 'lifecycle.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lifecycle = fs.existsSync(lifeFile) ? read(lifeFile) : {};
    const why = text => (reason ? `${text}: ${reason}` : text).slice(0, 180);
    if (action === 'cancel' || action === 'pause') {
      if (r.status !== 'running' || !entry?.stop) throw Error('Run is not active on this runner');
      // Written before the stop so the final receipt, and any later recovery scan, see the decision.
      save(lifeFile, { ...lifecycle, ...(action === 'cancel' ? { paused: why('Cancelled by operator') } : { held: why('Paused by operator; resume_run continues it') }) });
      const stopped = action === 'cancel' ? 'Cancelled by operator' : 'Paused by operator';
      entry.stopped = stopped; entry.stop(stopped);
      for (let i = 0; i < 40 && read(file).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 200));
    } else if (action === 'dismiss') {
      if (entry || !['failed', 'interrupted'].includes(r.status)) throw Error('Only a stopped failed or interrupted run can be dismissed');
      if (['resumed', 'completed', 'dismissed'].includes(r.recovery?.state)) throw Error(`Run recovery is already ${r.recovery.state}`);
      // Nothing is deleted: the workspace and checkpoint stay for inspection, and the conversation is unblocked.
      save(lifeFile, { ...lifecycle, dismissed: why('Dismissed by operator') });
      this.saveRecoveryInfo(run_id, this.recoveryInfo(run_id).info);
    } else {
      const value = this.recoveryInfo(run_id);
      if (entry || value.info.state !== 'awaiting_review' || value.lifecycle.inspection) throw Error('No failed recovery inspection to retry');
      const { inspection_started: _s, inspection_error: _e, ...rest } = value.lifecycle;
      save(lifeFile, rest);
      void this.inspectRecovery(r, { ...value, lifecycle: rest }).catch(() => {});
    }
    await this.report(run_id);
    const value = { run_id, action, before, after: controlView(read(file)) };
    save(request, { fingerprint: fp, run_id, value });
    return value;
  }
  async inspectRecovery(receipt, recovery) {
    if (this.draining || [...this.runs.values()].some(r => r.repo === receipt.repo)) return;
    if (this.runs.size >= this.limits.runs + this.limits.writeRuns) return;
    const dir = this.recoveryDir(receipt.run_id), file = path.join(dir, 'lifecycle.json');
    const lifecycle = { ...recovery.lifecycle, inspection_started: new Date().toISOString() };
    save(file, lifecycle); // one inspection per interrupted attempt, including across crashes
    const base = path.join(dir, 'inspection'); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const config = { ...recovery.setup.config, writable: false, resume: false, recover_from: undefined, checkpoint_file: undefined,
      policy: { ...recovery.setup.config.policy, readonly_workspace: true }, tools: ['read', 'grep', 'find', 'ls'],
      sessions: path.join(base, 'sessions'), agentDir: path.join(base, 'config'), conversation_id: 'inspection-' + receipt.run_id,
      slots: [recovery.checkpoint.runtime?.provider].filter(Boolean) };
    save(path.join(base, 'config.json'), config);
    this.runs.set(receipt.run_id, { write: false, repo: receipt.repo });
    try {
      const uncertain = Object.values(recovery.checkpoint.tools).filter(t => t.state === 'started').map(t => t.name);
      const prompt = `Read-only recovery inspection. The original task was: ${receipt.task}\nA crash interrupted these tools: ${uncertain.join(', ')}. Inspect relevant saved files and propose how to continue from their current state. Do not claim a command completed without evidence. Do not execute changes. Keep the report under 8000 characters.`;
      const output = await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/python3', [path.join(source, 'parent-exec.py'), String(process.pid), process.execPath,
          path.join(source, 'dev-session-worker.mjs'), path.join(base, 'config.json')], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        let out = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        this.runs.get(receipt.run_id).stop = () => child.kill('SIGKILL');
        child.stdout.on('data', b => { if (out.length + b.length > 262144) child.kill('SIGKILL'); else out += b; });
        child.stderr.resume(); child.stdin.on('error', () => {});
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', code => { clearTimeout(timer); try { const r = JSON.parse(out); if (code !== 0 || r.error) throw Error('Inspection unavailable'); resolve(r.output); } catch (e) { reject(e); } });
        child.stdin.end(prompt);
      });
      lifecycle.inspection = safeText(output).slice(0, 12000);
      if (!lifecycle.inspection) lifecycle.inspection = 'Inspection returned no usable output; leave paused for operator inspection.';
    } catch { lifecycle.inspection_error = 'Read-only inspection unavailable; operator inspection required'; }
    finally {
      this.runs.delete(receipt.run_id);
      save(file, lifecycle);
      this.saveRecoveryInfo(receipt.run_id, this.recoveryInfo(receipt.run_id).info);
      await this.report(receipt.run_id);
    }
  }
}
