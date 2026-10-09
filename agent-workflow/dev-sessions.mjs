// Trusted operator-installed supervisor; all paths come from its private configuration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAgent, loadMemory, buildSystemPrompt } from './agent.mjs';
import { linuxPolicy, sandboxExecute } from './linux-sandbox.mjs';
import { DEVELOPMENT, digest } from './dev-grants.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gitEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
export function save(file, value) {
  const temporary = file + '.' + randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const safeOutput = text => /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+\S+|-----BEGIN.*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.)/.test(text)
  ? '[redacted: output resembled a credential]' : text.slice(0, 48000);

export class DevelopmentSessions {
  constructor({ state, repository, knowledge, context, revision, processSession = randomUUID(), lease, limits = {} }) {
    if (process.platform !== 'linux') throw new Error('Development sessions require Linux');
    this.state = path.resolve(state); this.repository = fs.realpathSync(repository); this.knowledge = fs.realpathSync(knowledge);
    this.context = context ? fs.realpathSync(context) : null;
    this.revision = revision; this.processSession = processSession; this.lease = lease;
    const knowledgeManifest = read(path.join(this.knowledge, 'RELEASE.json'));
    for (const [name, expected] of Object.entries(knowledgeManifest.files)) {
      const file = fs.realpathSync(path.join(this.knowledge, name));
      if (!file.startsWith(this.knowledge + path.sep) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error('Reviewed knowledge integrity check failed');
    }
    this.limits = { diskBytes: 4 * 1024 ** 3, freeBytes: 20 * 1024 ** 3, taskMs: 30 * 60000, ...limits };
    this.active = null;
    fs.mkdirSync(this.state, { recursive: true, mode: 0o700 });
    for (const name of ['conversations', 'runs', 'requests', 'quarantine']) fs.mkdirSync(path.join(this.state, name), { mode: 0o700, recursive: true });
    for (const name of fs.readdirSync(path.join(this.state, 'runs'))) {
      const file = path.join(this.state, 'runs', name), r = read(file);
      if (r.status === 'running') save(file, { ...r, status: 'interrupted', stopped_at: Date.now(), error: 'Supervisor restarted; new grant required' });
    }
  }
  conversation(id) {
    if (!uuid(id)) throw new Error('Invalid conversation');
    return read(path.join(this.state, 'conversations', id, 'config.json'));
  }
  room() {
    const s = fs.statfsSync(this.state);
    if (s.bavail * s.bsize < this.limits.freeBytes) throw new Error('Host free-space watermark reached');
  }
  async prepare({ conversation_id } = {}) {
    if (this.active) throw new Error('Development host is busy; retry when idle');
    this.room();
    if (conversation_id) {
      const config = this.conversation(conversation_id);
      // Continue files/context, but permissions bind to this boot and installed release.
      if (config.manifest.implementation_revision !== this.revision || config.manifest.knowledge_revision !== read(path.join(this.knowledge, 'RELEASE.json')).source_revision) {
        throw new Error('Conversation uses an older release; operator migration required');
      }
      config.manifest.process_session = this.processSession;
      save(path.join(this.state, 'conversations', conversation_id, 'config.json'), config);
      return config.manifest;
    }
    const id = randomUUID(), base = path.join(this.state, 'conversations', id), workspace = path.join(base, 'workspace');
    fs.mkdirSync(base, { mode: 0o700 });
    // Source is the private supervisor-owned bare repository, never a supplied path.
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--no-hardlinks', '--no-checkout', this.repository, workspace], { env: gitEnv, stdio: 'pipe' });
    const agent = { ...getAgent('workflow', this.knowledge), workspace, writePaths: [workspace], protectPaths: [], context: this.context };
    let policy = linuxPolicy(agent, this.state);
    await sandboxExecute(policy, 'bash', { command: 'git -c core.hooksPath=/dev/null checkout -b development-session origin/main' });
    policy = linuxPolicy(agent, this.state);
    if (fs.existsSync(path.join(workspace, '.git/objects/info/alternates'))) throw new Error('Shared Git objects forbidden');
    const sessions = path.join(base, 'pi-sessions'), agentDir = path.join(base, 'pi-config');
    fs.mkdirSync(sessions, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
    agent.linuxPolicy = policy;
    const prompt = buildSystemPrompt(agent, loadMemory(agent.memory, this.knowledge)) + '\n\n' + agent.skills.map(dir => fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).join('\n\n')
      + (this.context ? `\nDated read-only Space reference is available at ${this.context}. The live Space remains the editable source. This reference is not live health evidence.` : '');
    const manifest = { host: DEVELOPMENT.host, project: DEVELOPMENT.project, agent: DEVELOPMENT.agent,
      conversation_id: id, workspace_id: hash(workspace), implementation_revision: this.revision,
      knowledge_revision: read(path.join(this.knowledge, 'RELEASE.json')).source_revision,
      policy_digest: await digest({ policy, prompt, limits: this.limits, revision: this.revision }), process_session: this.processSession };
    save(path.join(base, 'config.json'), { conversation_id: id, policy, prompt, sessions, agentDir, manifest });
    return manifest;
  }
  get(runId) {
    if (!uuid(runId)) throw new Error('Invalid run');
    return read(path.join(this.state, 'runs', runId + '.json'));
  }
  async start({ request_id, grant_id, conversation_id, task, policy_digest }) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(request_id) || !uuid(grant_id) || typeof task !== 'string' || !task.trim() || task.length > 16000) throw new Error('Invalid task');
    const fingerprint = hash({ grant_id, conversation_id, task, policy_digest });
    const requestFile = path.join(this.state, 'requests', request_id + '.json');
    if (fs.existsSync(requestFile)) {
      const old = read(requestFile);
      if (old.fingerprint !== fingerprint) throw new Error('Request identity conflict');
      return this.get(old.run_id);
    }
    if (this.active) throw new Error('Development host is busy; retry when idle');
    const config = this.conversation(conversation_id);
    if (config.manifest.policy_digest !== policy_digest || config.manifest.process_session !== this.processSession) throw new Error('Grant manifest mismatch');
    const leaseArgs = { grant_id, process_session: this.processSession, policy_digest, execution_state: 'running' };
    this.active = { starting: true, grant_id };
    try {
      this.room();
      const began = performance.now(), initial = await this.lease(leaseArgs);
      if (!initial.authorized || initial.lease_ms > DEVELOPMENT.leaseMs || initial.lease_ms <= 0) throw new Error('Execution lease refused');
      let deadline = began + initial.lease_ms;
      if (performance.now() >= deadline) throw new Error('Execution lease expired in transit');
      const run_id = randomUUID(), file = path.join(this.state, 'runs', run_id + '.json');
      const receipt = { run_id, grant_id, conversation_id, manifest: config.manifest, status: 'running', started_at: Date.now() };
      save(file, receipt); save(requestFile, { fingerprint, run_id });
      const child = spawn('/usr/bin/python3', [path.join(source, 'parent-exec.py'), String(process.pid), process.execPath, path.join(source, 'dev-session-worker.mjs'), path.join(this.state, 'conversations', conversation_id, 'config.json')],
        { cwd: source, stdio: ['pipe', 'pipe', 'pipe'], env: { HOME: os.homedir(), PATH: process.env.PATH, LANG: 'C.UTF-8' } });
      this.active = { child, run_id, grant_id };
      let stopped = false, output = '', bytes = 0, failure, killTimer, renewing = false, diskChecking = false;
      const stop = reason => {
        if (stopped) return; stopped = true; failure = reason;
        child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      };
      this.active.stop = stop;
      // This watchdog is outside the credential-owning Pi child and all shell namespaces.
      const watchdog = setInterval(() => { if (performance.now() >= deadline) stop('Execution lease expired'); }, 100);
      const renew = setInterval(async () => {
        if (renewing || stopped) return; renewing = true;
        const sent = performance.now();
        try {
          const next = await this.lease(leaseArgs);
          if (!next.authorized) stop('Execution revoked');
          else if (next.lease_ms > 0 && next.lease_ms <= DEVELOPMENT.leaseMs && !stopped) deadline = sent + next.lease_ms;
        } catch { /* Existing deadline remains authoritative while disconnected. */ }
        finally { renewing = false; }
      }, DEVELOPMENT.renewMs);
      const disk = setInterval(() => {
        if (diskChecking || stopped) return; diskChecking = true;
        try { this.room(); } catch { stop('Host free-space watermark reached'); }
        const du = spawn('du', ['-sk', '--', config.policy.workspace], { env: gitEnv });
        let size = ''; du.stdout.on('data', b => { if (size.length < 200) size += b; }); du.stderr.resume();
        du.on('error', () => { diskChecking = false; stop('Disk accounting unavailable'); });
        du.on('close', code => { diskChecking = false; if (code !== 0 || Number.parseInt(size) * 1024 > this.limits.diskBytes) stop('Session disk budget exceeded'); });
      }, 5000);
      const timeout = setTimeout(() => stop('Task time limit exceeded'), this.limits.taskMs);
      child.stdout.on('data', b => { bytes += b.length; if (bytes > 262144) stop('Result limit exceeded'); else output += b; });
      child.stderr.resume(); // SDK diagnostics never enter model-visible status or receipts.
      const done = async code => {
        clearInterval(watchdog); clearInterval(renew); clearInterval(disk); clearTimeout(timeout); clearTimeout(killTimer);
        let result = {};
        try { if (code === 0 && !failure) result = JSON.parse(output); } catch { failure = 'Invalid Pi result'; }
        save(file, { ...receipt, status: failure || code !== 0 ? 'interrupted' : 'completed', stopped_at: Date.now(),
          ...(failure ? { error: failure } : {}), output: safeOutput(result.output ?? ''), tool_calls: result.tool_calls ?? [],
          ...(/^[a-f0-9]{40,64}$/.test(result.commit ?? '') ? { commit: result.commit } : {}) });
        this.active = null;
        try { await this.lease({ ...leaseArgs, execution_state: 'stopped' }); } catch { /* stop remains unconfirmed on Hub until reconnect */ }
      };
      let finished = false;
      const finish = code => { if (!finished) { finished = true; void done(code); } };
      child.on('error', () => { failure = 'Pi process could not start'; finish(1); });
      child.on('close', finish); child.stdin.on('error', () => {}); child.stdin.end(task);
      return receipt;
    } catch (e) { this.active = null; throw e; }
  }
  stop() { this.active?.stop?.('Operator stopped supervisor'); }
  async export({ conversation_id, run_id, grant_id, policy_digest }) {
    if (this.active) throw new Error('Export requires an idle host');
    this.active = { exporting: true, grant_id };
    try {
    const config = this.conversation(conversation_id), receipt = this.get(run_id);
    if (receipt.conversation_id !== conversation_id || receipt.grant_id !== grant_id || config.manifest.policy_digest !== policy_digest || receipt.status !== 'completed') throw new Error('Export requires a completed matching run and grant');
    const leaseArgs = { grant_id, process_session: this.processSession, policy_digest, execution_state: 'running' };
    const began = performance.now(), permit = await this.lease(leaseArgs);
    if (!permit.authorized || permit.lease_ms <= 0 || permit.lease_ms > DEVELOPMENT.leaseMs) throw new Error('Export lease refused');
    const filename = '.git/review-' + run_id + '.bundle';
    if (!/^[a-f0-9]{40,64}$/.test(receipt.commit ?? '')) throw new Error('Task has no recorded commit');
    const exportRef = 'refs/heads/export-' + run_id;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(0, permit.lease_ms - (performance.now() - began)));
    try { await sandboxExecute(config.policy, 'bash', { command: `git -c core.hooksPath=/dev/null update-ref ${exportRef} ${receipt.commit} && git -c core.hooksPath=/dev/null bundle create ${filename} ${exportRef}` }, { signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (!(await this.lease(leaseArgs)).authorized) throw new Error('Export revoked before import');
    const candidate = fs.realpathSync(path.join(config.policy.workspace, filename));
    if (!candidate.startsWith(config.policy.workspace + path.sep)) throw new Error('Invalid export path');
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const target = path.join(this.state, 'quarantine', run_id + '.bundle');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 ** 2) throw new Error('Export exceeds 64 MiB limit');
      if (!fs.existsSync(target)) fs.writeFileSync(target, fs.readFileSync(fd), { mode: 0o400, flag: 'wx' });
    } finally { fs.closeSync(fd); }
    const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', '--git-dir', this.repository];
    const ref = `refs/heads/review/${conversation_id}/${run_id}`;
    // No plus/force: existing review refs cannot be replaced. No checkout or hooks.
    execFileSync('git', [...args, 'bundle', 'verify', target], { env: gitEnv, stdio: 'pipe' });
    const head = execFileSync('git', [...args, 'bundle', 'list-heads', target, exportRef], { env: gitEnv, timeout: 15000, encoding: 'utf8' }).split(' ')[0];
    if (head !== receipt.commit) throw new Error('Bundle does not match task commit');
    try {
      const existing = execFileSync('git', [...args, 'rev-parse', '--verify', ref], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (existing !== head) throw new Error('Review ref already exists with different content');
      return { ref, commit: head };
    } catch (error) { if (error.message === 'Review ref already exists with different content') throw error; }
    execFileSync('git', [...args, 'fetch', '--no-tags', '--no-write-fetch-head', target, `${exportRef}:${ref}`], { env: gitEnv, timeout: 15000, stdio: 'pipe' });
    return { ref, commit: head };
    } finally {
      this.active = null;
      try { await this.lease({ grant_id, process_session: this.processSession, policy_digest, execution_state: 'stopped' }); } catch {}
    }
  }
}
