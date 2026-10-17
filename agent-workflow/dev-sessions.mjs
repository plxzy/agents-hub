// Trusted operator-installed supervisor; all paths come from its private configuration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAgent, loadAgents, loadMemory, buildSystemPrompt, newId, extractRemember } from './agent.mjs';
import { linuxPolicy, sandboxExecute } from './linux-sandbox.mjs';
import { DEVELOPMENT, digest } from './dev-grants.mjs';
import { DEVELOPMENT_RUNTIME, runtimeMatches, agentRuntime } from './dev-runtime.mjs';
import { titleOf } from './contract.mjs';
import { failedResult, sanitizeFailureContext } from './failure-telemetry.mjs';
import { runProgressTelemetry, sanitizeProgress, progressPublisher, appendStep } from './run-progress.mjs';
import { captureRunContext, logObservation } from './run-context.mjs';
import { runConfiguration } from './run-config.mjs';
import { save, read, syncDirectory } from './durable-file.mjs';
import { RunJournal, fingerprint } from './run-recovery.mjs';
import { RecoveryHost } from './run-recovery-host.mjs';
import { retryableModelFailure } from './recovery-contract.mjs';
import { reviewSource, verifyContinuationHead, publicSourcePr } from './run-continuation.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
function saveConversationHead(base, id) {
  const temporary = path.join(base, 'head.' + randomUUID());
  try {
    fs.writeFileSync(temporary, id, { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, path.join(base, 'head'));
    syncDirectory(base);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gitEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
export { save } from './durable-file.mjs';
const safeOutput = text => /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+\S+|-----BEGIN.*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.)/.test(text)
  ? '[redacted: output resembled a credential]' : text.slice(0, 48000);

const READ_ONLY = ['read', 'grep', 'find', 'ls'];
const ALL_TOOLS = [...READ_ONLY, 'write', 'edit', 'bash'];
export const RUN_ID = /^r-\d{8}T\d{6}Z-[a-f0-9]{6}$/;

// Persist first. The cleanup callback cannot run if result construction or durable storage fails.
export function persistRunCompletion({ file, receipt, result, observed, done, code, failure, remembered = [], commit, baseCommit, harvested, cleanup, persist = save }) {
  const terminal = { ...receipt, status: failure || result.error ? 'failed' : code === 0 ? 'completed' : 'interrupted',
        ...(remembered.length ? { memory_proposed: remembered.length, memory_proposals: remembered } : {}),
        ended: new Date().toISOString(), ...(commit ? { commit } : {}), ...(baseCommit ? { base_commit: baseCommit } : {}),
        ...(done && harvested ? harvested : {}), ...(observed ? { runtime: observed } : {}),
        ...(failure || result.error ? { error: failure ?? result.error } : {}),
        output: safeOutput(result.output ?? ''), tool_calls: Array.isArray(result.tool_calls) ? result.tool_calls.slice(0, 500) : [],
        ...(result.runtime || observed || receipt.mcp_connection ? { configuration: runConfiguration({ runtime: result.runtime ?? observed, mcp_connection: receipt.mcp_connection }) } : {}),
        ...(!done ? { failure_context: result.failure_context, output_partial: result.output_partial } : {}),
        ...(result.usage ? { usage: result.usage } : {}), ...(Number.isInteger(result.model_calls) ? { model_calls: result.model_calls } : {}),
        ...(Array.isArray(result.slots_used) ? { accounts_used: result.slots_used.filter(s => /^openai(-[1-9]\d*)?$/.test(s)) } : {}) };
  persist(file, terminal);
  if (done && cleanup) {
    try { cleanup(); } catch { /* Keep the durable result; retained artifacts can be cleaned later. */ }
  }
  return terminal;
}

export class DevelopmentSessions extends RecoveryHost {
  constructor({ state, repository, repositories = {}, knowledge, context, revision, processSession = randomUUID(), lease, report, accounts, knowledgeHub, hub_agents = null, accounts_module = null, prepareBase = null, prepareReview = null, publishes = null, limits = {} }) {
    super();
    if (process.platform !== 'linux') throw new Error('Development sessions require Linux');
    this.state = path.resolve(state); this.repository = fs.realpathSync(repository); this.knowledge = fs.realpathSync(knowledge);
    this.repos = { [path.basename(this.repository).replace(/\.git$/, '')]: this.repository,
      ...Object.fromEntries(Object.entries(repositories).map(([name, dir]) => [name, fs.realpathSync(dir)])) };
    this.context = context ? fs.realpathSync(context) : null;
    this.revision = revision; this.processSession = processSession; this.lease = lease; this.reporter = report;
    this.prepareBase = prepareBase; this.prepareReview = prepareReview; this.publishes = publishes;
    this.accounts = accounts; this.accountsModule = accounts_module; this.knowledgeHub = knowledgeHub;
    // Agent definitions published to the Hub (a folder with agents/*.md written at boot); the frozen release is the fallback.
    this.hubAgents = hub_agents ? fs.realpathSync(hub_agents) : null;
    const knowledgeManifest = read(path.join(this.knowledge, 'RELEASE.json'));
    for (const [name, expected] of Object.entries(knowledgeManifest.files)) {
      const file = fs.realpathSync(path.join(this.knowledge, name));
      if (!file.startsWith(this.knowledge + path.sep) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error('Reviewed knowledge integrity check failed');
    }
    // Two independent clones may run at once. A repository lock below still serializes work aimed at
    // the same project; these limits bound model, disk and account pressure.
    this.limits = { diskBytes: 4 * 1024 ** 3, freeBytes: 20 * 1024 ** 3, taskMs: 30 * 60000, runs: 2, runMs: 15 * 60000, writeRuns: 2, writeMs: 30 * 60000, keepConversations: 20, keepMs: 7 * 24 * 3600000,
      autoRecovery: false, slots: ['openai'], cooldownMs: 60 * 60000, disableMs: 24 * 60 * 60000, ...limits };
    this.active = null;
    this.runs = new Map();
    fs.mkdirSync(this.state, { recursive: true, mode: 0o700 });
    for (const name of ['conversations', 'runs', 'requests', 'quarantine', 'agent-runs', 'agent-requests', 'run-work', 'recovery-v1']) fs.mkdirSync(path.join(this.state, name), { mode: 0o700, recursive: true });
    // A linked resume intent is authoritative even if the process died before writing its receipt.
    for (const id of fs.readdirSync(path.join(this.state, 'recovery-v1'))) {
      try {
        const link = read(path.join(this.recoveryDir(id), 'lifecycle.json'));
        if (!RUN_ID.test(link.resumed_by ?? '')) continue;
        const setup = read(path.join(this.recoveryDir(link.resumed_by), 'setup.json'));
        const request = path.join(this.state, 'agent-requests', setup.receipt.request_id + '.json');
        if (!fs.existsSync(request)) save(request, { fingerprint: setup.request_fingerprint, run_id: link.resumed_by, receipt: setup.receipt });
      } catch { /* Invalid recovery evidence stays quarantined. */ }
    }
    // Recover reserved identities before inspecting receipts; never admit an orphan twice.
    for (const name of fs.readdirSync(path.join(this.state, 'agent-requests'))) {
      try { const intent = read(path.join(this.state, 'agent-requests', name));
        const dest = path.join(this.state, 'agent-runs', intent.run_id + '.json');
        if (intent.receipt && RUN_ID.test(intent.run_id) && !fs.existsSync(dest)) save(dest, intent.receipt);
      } catch { /* Retain corrupt evidence without taking down unrelated runs. */ }
    }
    for (const name of fs.readdirSync(path.join(this.state, 'agent-runs'))) {
      try {
        const file = path.join(this.state, 'agent-runs', name), r = read(file);
        if (r.status === 'running') save(file, { ...r, status: 'interrupted', ended: new Date().toISOString(),
          error: 'Runner restarted during the run', reported_at: undefined, recovery: { ...this.recoveryInfo(r.run_id).info, revision: (r.recovery?.revision ?? 0) + 1 } });
      } catch { /* Preserve malformed receipt for operator recovery. */ }
    }
    // Unfinished work is recovery evidence; never delete it at supervisor startup.
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
  // Operator-only migration. Deliberately absent from all Hub/host operations.
  // Stop the managed supervisor first; files and Pi history remain in place.
  migrate(conversation_id) {
    if (this.active) throw new Error('Stop execution before migration');
    const config = this.conversation(conversation_id);
    if (config.manifest.knowledge_revision !== read(path.join(this.knowledge, 'RELEASE.json')).source_revision) throw new Error('Knowledge migration requires separate review');
    const agent = { ...getAgent('workflow', this.knowledge), workspace: config.policy.workspace,
      writePaths: [config.policy.workspace], protectPaths: [], context: this.context };
    config.policy = linuxPolicy(agent, this.state);
    const file = path.join(this.state, 'conversations', conversation_id, 'config.json');
    return (async () => {
      config.manifest = { ...config.manifest, implementation_revision: this.revision, runtime: DEVELOPMENT_RUNTIME,
        policy_digest: await digest({ policy: config.policy, prompt: config.prompt, runtime: DEVELOPMENT_RUNTIME, limits: this.limits, revision: this.revision }),
        process_session: this.processSession };
      fs.copyFileSync(file, file + '.before-migration-' + randomUUID());
      save(file, config);
      return config.manifest;
    })();
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
      runtime: DEVELOPMENT_RUNTIME,
      policy_digest: await digest({ policy, prompt, runtime: DEVELOPMENT_RUNTIME, limits: this.limits, revision: this.revision }), process_session: this.processSession };
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
        { cwd: source, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { HOME: os.homedir(), PATH: process.env.PATH, LANG: 'C.UTF-8' } });
      this.active = { child, run_id, grant_id };
      let stopped = false, output = '', bytes = 0, failure, killTimer, renewing = false, diskChecking = false;
      const stop = reason => {
        if (stopped) return; stopped = true; failure = reason;
        child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      };
      this.active.stop = stop;
      let runtime;
      child.on('message', message => {
        if (message?.type !== 'runtime' || !runtimeMatches(message.runtime, config.manifest.runtime)
          || message.runtime?.conversation_id !== conversation_id || message.runtime?.policy_digest !== policy_digest) {
          stop('Pi runtime identity mismatch'); return;
        }
        runtime = message.runtime;
        save(file, { ...receipt, runtime });
      });
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
        try { result = JSON.parse(output || '{}'); } catch { failure ??= 'Invalid Pi result'; }
        if (code === 0 && !failure && (!runtime || !runtimeMatches(result.runtime, config.manifest.runtime))) failure = 'Missing verified Pi runtime';
        if (failure || result.error || code !== 0) result = failedResult(result, {}, failure ?? result.error ?? 'Pi process exited');
        save(file, { ...receipt, status: failure || result.error || code !== 0 ? 'interrupted' : 'completed', stopped_at: Date.now(),
          ...(runtime ? { runtime } : {}),
          ...(failure || result.error ? { error: failure ?? result.error } : {}), output: safeOutput(result.output ?? ''), tool_calls: result.tool_calls ?? [],
          ...(result.failure_context ? { failure_context: result.failure_context, output_partial: result.output_partial } : {}),
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
  stop() {
    this.draining = true;
    this.active?.stop?.('Operator stopped supervisor');
    for (const run of this.runs.values()) { run.stopped = 'Runner stopped'; run.stop?.('Runner stopped'); }
  }

  // ---------- one-shot agent runs (a fresh clone per run; no grant needed) ----------
  // Read-only agents get a read-only clone. Agents with write tools get a writable clone inside the same
  // sandbox as development sessions; their result leaves only as an append-only review ref, never merged.
  project() { return path.basename(this.repository).replace(/\.git$/, ''); }
  runnable() {
    return loadAgents(this.hubAgents ?? this.knowledge).filter(a => a.tools.length && a.tools.every(t => ALL_TOOLS.includes(t))
      && (a.workspace === 'here' || this.repos[path.basename(a.workspace)]));
  }
  isWrite(agent) { return agent.tools.some(t => !READ_ONLY.includes(t)); }
  // A fixed-workspace agent works in the repo named like its workspace; `workspace: here` agents choose one.
  repoFor(agent, repo) {
    const names = Object.keys(this.repos);
    if (agent.workspace !== 'here') {
      const own = path.basename(agent.workspace);
      if (repo && repo !== own) throw new Error(`${agent.name} works in ${own} only`);
      return own;
    }
    const chosen = repo ?? (names.length === 1 ? names[0] : null);
    if (!chosen || !this.repos[chosen]) throw new Error(`Choose a repo: ${names.join(', ')}`);
    return chosen;
  }
  runGet(runId) {
    if (!RUN_ID.test(runId ?? '')) throw new Error('Invalid run');
    const file = path.join(this.state, 'agent-runs', runId + '.json');
    if (!fs.existsSync(file)) throw new Error('Unknown run');
    const { reported_at, root, ...receipt } = read(file);
    return { ...receipt, review_conversation_id: root ?? receipt.run_id };
  }
  runSelection() {
    return { version: 1, agents: this.runnable().map(agent => {
      let repo, reason;
      try { repo = this.repoFor(agent); } catch { reason = 'Choose a repository through the existing hosted tools; this form uses agent defaults only.'; }
      const write = this.isWrite(agent);
      const active = [...this.runs.values()];
      if (!reason && repo && active.some(r => r.repo === repo)) reason = `repository ${repo} is busy; wait for its current run to finish.`;
      if (!reason && active.filter(r => r.write === write).length >= (write ? this.limits.writeRuns : this.limits.runs)) reason = `dok ${write ? 'write' : 'read-only'} capacity is full; wait for a slot.`;
      return { name: agent.name, model: agent.model, ...(repo ? { repo } : {}), ...(repo && this.publishes ? { publishes: this.publishes(repo) } : {}), ...(reason ? { reason } : {}) };
    }) };
  }
  runLookup(requestId) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId ?? '')) throw new Error('Invalid request identity');
    const file = path.join(this.state, 'agent-requests', requestId + '.json');
    if (!fs.existsSync(file)) return { state: 'not_found' };
    const { run_id } = read(file), r = this.runGet(run_id);
    return { state: 'started', run_id, status: r.status, runner: 'dok' };
  }
  runStart(args) {
    // Serialize preparation as it awaits GitHub; duplicate starts must see the first durable request.
    const next = (this.startQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.preparingStarts = (this.preparingStarts ?? 0) + 1;
      try { return await this.startPreparedRun(args); } finally { this.preparingStarts--; }
    });
    this.startQueue = next;
    return next;
  }
  async startPreparedRun({ request_id, agent: name, task, model, thinking, repo, continue_from, pr_number, issue_number, mcp_connection }) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(request_id ?? '') || typeof task !== 'string' || !task.trim() || task.length > 16000) throw new Error('Invalid task');
    if (continue_from !== undefined && !RUN_ID.test(continue_from)) throw new Error('Invalid continue_from');
    if (pr_number !== undefined && (!Number.isSafeInteger(pr_number) || pr_number < 1 || continue_from !== undefined)) throw Error('Invalid PR selection');
    if (issue_number !== undefined && (!Number.isSafeInteger(issue_number) || issue_number < 1)) throw Error('Invalid issue_number');
    const fingerprint = hash({ agent: name, task, model: model ?? null, thinking: thinking ?? null, repo: repo ?? null, continue_from: continue_from ?? null,
      ...(pr_number !== undefined ? { pr_number } : {}), ...(issue_number !== undefined ? { issue_number } : {}) });
    const requestFile = path.join(this.state, 'agent-requests', request_id + '.json');
    if (fs.existsSync(requestFile)) {
      const old = read(requestFile);
      if (old.fingerprint !== fingerprint) throw new Error('Request identity conflict');
      return this.runGet(old.run_id);
    }
    if (this.draining) throw new Error('Runner draining; retry when available');
    const agent = this.runnable().find(a => a.name === name);
    if (!agent) throw new Error('Agent is not runnable on dok');
    const write = this.isWrite(agent), project = this.repoFor(agent, repo);
    if ((continue_from || pr_number) && !write) throw new Error('continue_from applies to runs that change files');
    const active = [...this.runs.values()];
    if (active.some(r => r.repo === project)) throw new Error(`repository ${project} is busy; wait for its current run to finish`);
    if (active.filter(r => r.write === write).length >= (write ? this.limits.writeRuns : this.limits.runs)) throw new Error(`dok ${write ? 'write' : 'read-only'} capacity is full; wait for a slot`);
    this.room();
    const runtime = agentRuntime({ model: model ?? agent.model, thinking: thinking ?? agent.thinking }), run_id = newId('r');
    if (!(this.limits.providers ?? ['openai']).includes(runtime.provider)) throw new Error('Provider not available on dok');
    let root, previous, sourceReview, prepared;
    if (continue_from) {
      const storedFile = path.join(this.state, 'agent-runs', continue_from + '.json');
      if (!fs.existsSync(storedFile)) throw new Error('Unknown run to continue');
      previous = read(storedFile); root = previous.root;
      sourceReview = reviewSource(previous);
      if (previous.agent !== agent.name || previous.repo !== project || previous.status !== 'completed'
        || !(sourceReview || publicSourcePr(previous.source_pr)) || !root)
        throw new Error('Continue a completed review of this agent and repository; use resume_run for saved failed work');
    }
    if ((root || pr_number) && this.prepareReview) prepared = await this.prepareReview(project, run_id, root ? { root } : { pr_number });
    if (this.draining) throw Error('Runner draining; retry when available');
    if (pr_number && !prepared) throw Error('PR continuation unavailable for this repository');
    if (prepared) {
      if (!publicSourcePr(prepared.source_pr) || prepared.commit !== prepared.source_pr.commit || prepared.ref !== `refs/heads/base/runs/${run_id}`)
        throw Error('Invalid prepared PR source');
      root = prepared.source_pr.root;
    }
    if (root) {
      let latest; try { latest = fs.readFileSync(path.join(this.state, 'run-work', root, 'head'), 'utf8').trim(); } catch { /* history may expire */ }
      if (continue_from && latest !== continue_from && (latest || !prepared))
        throw new Error(latest ? `Continue from the latest run of this conversation: ${latest}` : 'Conversation expired; import the saved review artifact instead of starting from main');
      if (!previous && latest) {
        previous = read(path.join(this.state, 'agent-runs', latest + '.json'));
        if (previous.agent !== agent.name || previous.repo !== project) throw Error('Use the same agent and repository for this PR');
      }
      for (const name of fs.readdirSync(path.join(this.state, 'agent-runs'))) {
        let other;
        try { other = read(path.join(this.state, 'agent-runs', name)); }
        catch { throw Error('Run history unreadable; inspect retained work before continuing'); }
        if (other.root === root && other.status !== 'completed' && !other.recovery?.resumed_by && other.recovery?.state !== 'dismissed')
          throw new Error(`Retained unfinished work requires recovery: ${other.run_id}`);
      }
    }
    // A follow-up keeps the conversation's issue unless it names one.
    const issue = issue_number ?? previous?.issue_number;
    const receipt = { run_id, request_id, agent: agent.name, kind: 'task', runner: 'dok', status: 'running', task, title: titleOf(task),
      started: new Date().toISOString(), model: `${runtime.provider}/${runtime.model}`, thinking: runtime.thinking, agent_version: agent.version,
      repo: project, write, ...(issue ? { issue_number: issue } : {}), ...(mcp_connection ? { mcp_connection } : {}),
      progress: runProgressTelemetry().snapshot(), ...(continue_from || previous ? { continued_from: continue_from ?? previous.run_id } : {}),
      ...(prepared ? { source_pr: prepared.source_pr, source_ref: prepared.ref } : sourceReview ? { source_review: sourceReview } : {}), root: root ?? run_id };
    save(requestFile, { fingerprint, run_id, receipt });
    save(path.join(this.state, 'agent-runs', run_id + '.json'), receipt);
    this.runs.set(run_id, { write, repo: project });
    void this.report(run_id);
    // Clone and execution continue after the start acknowledgement; the transport attempt is short.
    void this.executeRun(agent, runtime, receipt, previous).catch(() => this.finalizationFailed(receipt));
    const { root: _root, ...visible } = receipt;
    return visible;
  }
  async executeRun(bootAgent, runtime, receipt, previous, recovery) {
    const io = this.runIO ?? { spawn, sandboxExecute, linuxPolicy, execFileSync };
    let agent = bootAgent;
    const { write, repo, root } = receipt, repository = this.repos[repo];
    const base = path.join(this.state, 'run-work', root), workspace = path.join(base, 'workspace');
    const file = path.join(this.state, 'agent-runs', receipt.run_id + '.json');
    const entry = this.runs.get(receipt.run_id);
    const recoveryDir = this.recoveryDir(receipt.run_id);
    fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    let branch = receipt.source_pr ? receipt.source_ref.slice('refs/heads/'.length) : receipt.source_review ? receipt.source_review.review_ref.slice('refs/heads/'.length) : 'main';
    let failure, output = '', bytes = 0, observed, commit, baseCommit, harvested, killTimer, timeout, diskTimer, policy, configFile, slots, checkpoint = {};
    // receipt.progress_steps also lands in the final receipt; the output tail is shown only while running.
    receipt.progress_steps = [];
    const progress = progressPublisher(async update => {
      save(file, { ...receipt, ...(commit ? { commit } : {}), ...(observed ? { runtime: observed } : {}), progress: update,
        ...(checkpoint.output ? { progress_output: checkpoint.output.slice(-2000) } : {}) });
      await this.report(receipt.run_id);
    });
    progress.update(receipt.progress);
    const finish = async (code, result = {}) => {
      clearTimeout(timeout); clearTimeout(killTimer); clearInterval(diskTimer);
      await progress.stop();
      const { provider: _p, ...pinnedRuntime } = runtime;
      if (code === 0 && !failure && !(runtimeMatches(result.runtime, pinnedRuntime) && (runtime.provider !== 'openai' ? result.runtime.provider === runtime.provider : this.limits.slots.includes(result.runtime.provider)))) failure = 'Missing verified Pi runtime';
      const done = !failure && !result.error && code === 0;
      if (!done) result = failedResult(result, checkpoint, failure ?? result.error ?? 'Pi process exited');
      // ```remember blocks become memory candidates (sent with the receipt); they are not part of the shown answer.
      const remembered = done ? extractRemember(result.output, agent).slice(0, 5) : [];
      if (typeof result.output === 'string') result.output = result.output.replace(/```remember\n[\s\S]*?```/g, '').trim();
      receipt.logs = logObservation(path.join(base, 'pi-sessions'), 'session');
      if (done && receipt.recovery) receipt.recovery = { ...receipt.recovery, state: 'completed' };
      const terminal = persistRunCompletion({ file, receipt, result, observed, done, code, failure, remembered, commit, baseCommit, harvested,
        cleanup: () => { /* Completed work alone is eligible for cleanup, after the result is durable. */
          if (write && (harvested?.review_ref || receipt.source_review || receipt.source_pr)) saveConversationHead(base, receipt.run_id);
          fs.rmSync(write ? workspace : base, { recursive: true, force: true });
          if (!write && receipt.logs.status === 'recorded') {
            const terminal = read(file);
            save(file, { ...terminal, logs: { kind: 'session', status: 'removed', observed_at: new Date().toISOString() } });
          }
        } });
      if (!done) {
        if (retryableModelFailure(terminal)) {
          const lifecycleFile = path.join(recoveryDir, 'lifecycle.json');
          const lifecycle = fs.existsSync(lifecycleFile) ? read(lifecycleFile) : {};
          save(lifecycleFile, { ...lifecycle, automatic_eligible: true });
        }
        const info = this.recoveryInfo(receipt.run_id).info;
        // Failed model turns are terminal unless a command or process interruption needs reconciliation.
        const interrupted = !result.error || info.state === 'awaiting_review' || ['Runner stopped', 'Pi process exited', 'Invalid Pi result', 'Run state persistence failed', 'Cancelled by operator', 'Paused by operator'].includes(failure);
        save(file, { ...terminal, ...(interrupted ? { status: 'interrupted' } : {}), recovery: info });
      }
      this.runs.delete(receipt.run_id);
      // Write conversations keep their Pi history (not the checkout) so a follow-up can continue; others are removed.
      if (write && done) this.prune();
      await this.report(receipt.run_id);
    };
    try {
      if (recovery) {
        const setup = recovery.setup;
        policy = setup.config.policy; configFile = path.join(recoveryDir, 'config.json'); slots = setup.config.slots;
        baseCommit = setup.baseCommit; commit = setup.commit; agent = setup.agent;
        save(configFile, setup.config);
      } else {
      if (!receipt.source_review && !receipt.source_pr && this.prepareBase) {
        const fresh = await this.prepareBase(repo, receipt.run_id);
        if (fresh) {
          branch = fresh.ref.slice('refs/heads/'.length);
          receipt.github_base = { commit: fresh.commit, observed_at: fresh.observed_at };
          save(file, receipt);
        }
      }
      if (receipt.source_review) {
        let savedHead;
        try { savedHead = io.execFileSync('git', ['--git-dir', repository, 'rev-parse', '--verify', receipt.source_review.review_ref], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
        catch { throw Error('Saved review ref unavailable; import the original Hub artifact'); }
        verifyContinuationHead(receipt.source_review, savedHead);
      }
      if (receipt.source_pr) {
        const actual = io.execFileSync('git', ['--git-dir', repository, 'rev-parse', '--verify', receipt.source_ref], { env: gitEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
        if (actual !== receipt.source_pr.commit) throw Error('Prepared PR commit mismatch');
      }
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      fs.rmSync(workspace, { recursive: true, force: true });
      // Source is the supervisor-owned bare repository; checkout runs inside the sandbox.
      io.execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-checkout', '--no-tags', '--single-branch', '--branch', branch,
        ...(write ? [] : ['--depth', '1']), 'file://' + repository, workspace], { env: gitEnv, stdio: 'pipe', timeout: 120000 });
      const checkout = io.linuxPolicy({ ...agent, workspace, writePaths: [workspace], protectPaths: [], skills: [], context: null }, this.state);
      await io.sandboxExecute(checkout, 'bash', { command: write ? `git -c core.hooksPath=/dev/null checkout -q -b agent-run origin/${branch}` : `git -c core.hooksPath=/dev/null checkout -q --detach origin/${branch}` });
      // Read before the agent can touch the checkout; later git calls on it run only inside the sandbox.
      baseCommit = commit = io.execFileSync('git', ['--git-dir', path.join(workspace, '.git'), 'rev-parse', 'HEAD'], { env: gitEnv, encoding: 'utf8' }).trim();
      if (receipt.source_review) verifyContinuationHead(receipt.source_review, commit);
      if (receipt.source_pr && commit !== receipt.source_pr.commit) throw Error('Prepared PR checkout mismatch');
      if (receipt.github_base && receipt.github_base.commit !== commit) throw Error('Fresh GitHub base identity mismatch');
      // Observe after checkout, before Pi can modify Git configuration or the tree.
      Object.assign(receipt, captureRunContext(workspace), { repo, base_commit: baseCommit });
      save(file, { ...receipt, commit });
      // The Hub holds the agent's definition, skills and accepted memory. Files go to a folder outside the workspace
      // (skills are mounted read-only from there); the frozen release is only the fallback when the Hub is unreachable.
      let memory, kb = null;
      try { kb = this.knowledgeHub ? await this.knowledgeHub(agent.name) : null; } catch { /* fall back below */ }
      if (kb && kb.files && Array.isArray(kb.memory)) {
        const dir = path.join(base, 'kb');
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [name, content] of Object.entries(kb.files)) {
          if (typeof content !== 'string' || /(^|\/)\.\.(\/|$)|^\//.test(name) || !/^(agents|agent-skills)\//.test(name)) continue;
          const dest = path.join(dir, name);
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.writeFileSync(dest, content, { mode: 0o600 });
        }
        const live = loadAgents(dir).find(a => a.name === agent.name);
        if (!live) throw new Error('Hub definition unreadable');
        if (this.isWrite(live) !== write) throw new Error('Agent definition changed; restart the runner');
        agent = { ...live, workspace: bootAgent.workspace };
        memory = kb.memory.map(m => ({ meta: { id: m.id, scope: m.scope, status: 'accepted' }, body: m.body }));
        receipt.memory_source = 'hub'; receipt.memory_hash = kb.hash; receipt.agent_version = live.version;
      } else {
        memory = loadMemory(agent.memory, this.knowledge);
        receipt.memory_source = 'frozen-release';
      }
      policy = write ? io.linuxPolicy({ ...agent, workspace, writePaths: [workspace], protectPaths: [], context: this.context }, this.state)
        : io.linuxPolicy({ ...agent, workspace, protectPaths: [], context: this.context }, this.state, { readOnly: true });
      const skills = agent.skills === 'none' ? [] : agent.skills;
      const boundary = write
        ? `You run on dok, the always-on Linux runner, in a writable clone of ${repo} (${branch} at ${commit.slice(0, 12)}). Your shell has no network and cannot see credentials or other runs. Do not commit: when you stop, your changes are committed and exported as a review branch for the user, never merged automatically. Mac paths in notes describe the Mac; tools that exist only on macOS are unavailable here.`
        : `You run on dok, the always-on Linux runner, over a read-only clone of ${repo} (${branch} at ${commit.slice(0, 12)}). Mac paths in notes describe the Mac; files outside this clone are not available.`;
      const prompt = buildSystemPrompt({ ...agent, workspace }, memory)
        + (skills.length ? '\n\n' + skills.map(dir => fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).join('\n\n') : '')
        + `\n\n## Current host boundary (dok)\n${boundary}`
        + (receipt.source_pr ? `\nPR source: ${JSON.stringify(receipt.source_pr)}. This checkout includes reviewer fixes on the PR branch. Review and fix this PR; publication must preserve this starting commit.` : '')
        + (receipt.source_review ? `\nSaved review source: ${JSON.stringify(receipt.source_review)}. Review the original patch against its recorded base; this checkout starts at its saved commit. A no-edit review preserves that artifact and does not create a new one.` : '');
      const manifest = { host: DEVELOPMENT.host, project: repo, agent: agent.name, run_id: receipt.run_id, commit,
        implementation_revision: this.revision, knowledge_revision: read(path.join(this.knowledge, 'RELEASE.json')).source_revision,
        policy_digest: await digest({ policy, prompt, runtime, revision: this.revision }) };
      const sessions = path.join(base, 'pi-sessions'), agentDir = path.join(base, 'pi-config');
      fs.mkdirSync(sessions, { recursive: true, mode: 0o700 }); fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      configFile = path.join(recoveryDir, 'config.json');
      slots = runtime.provider === 'openai' ? await this.poolSlots() : [runtime.provider];
      if (previous) {
        // Reasoning history is bound to the account that produced it: continue on that account or not at all.
        const last = previous.accounts_used?.at(-1);
        if (!last || !slots.includes(last)) throw new Error('The previous run’s account is unavailable; retry later');
        slots = [last];
      }
      const config = { checkpoint_file: path.join(recoveryDir, 'checkpoint.json'), remaining_ms: write ? this.limits.writeMs : this.limits.runMs, mode: 'run', writable: write, resume: Boolean(previous), conversation_id: root, policy, prompt, sessions, agentDir, runtime,
        tools: agent.tools, manifest, slots, accounts_module: this.accountsModule };
      save(configFile, config);
      new RunJournal(config.checkpoint_file, { remainingMs: config.remaining_ms });
      save(path.join(recoveryDir, 'setup.json'), { schema: 1, revision: this.revision, agent, runtime, receipt, config, baseCommit, commit, attempt: 0 });
      }
      if (entry?.stopped) throw new Error(entry.stopped);
      const child = io.spawn('/usr/bin/python3', [path.join(source, 'parent-exec.py'), String(process.pid), process.execPath, path.join(source, 'dev-session-worker.mjs'), configFile],
        { cwd: source, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { HOME: os.homedir(), PATH: process.env.PATH, LANG: 'C.UTF-8' } });
      let stopped = false;
      const stop = reason => {
        if (stopped) return; stopped = true; failure = reason;
        child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      };
      if (entry) entry.stop = stop;
      timeout = setTimeout(() => stop('Run time limit exceeded'), recovery ? recovery.checkpoint.remaining_ms : write ? this.limits.writeMs : this.limits.runMs);
      if (write) {
        let checking = false;
        diskTimer = setInterval(() => {
          if (checking || stopped) return; checking = true;
          try { this.room(); } catch { stop('Host free-space watermark reached'); }
          const du = io.spawn('du', ['-sk', '--', workspace], { env: gitEnv });
          let size = ''; du.stdout.on('data', b => { if (size.length < 200) size += b; }); du.stderr.resume();
          du.on('error', () => { checking = false; stop('Disk accounting unavailable'); });
          du.on('close', code => { checking = false; if (code !== 0 || Number.parseInt(size) * 1024 > this.limits.diskBytes) stop('Run disk budget exceeded'); });
        }, 5000);
      }
      const { provider: _provider, ...pinned } = runtime;
      child.on('message', message => {
        try {
        if (message?.type === 'checkpoint' && observed) {
          checkpoint = { output: safeOutput(typeof message.partial?.output === 'string' ? message.partial.output : ''),
            failure_context: sanitizeFailureContext(message.partial?.failure_context) };
          const update = sanitizeProgress(message.progress);
          if (update) { receipt.progress = update; appendStep(receipt.progress_steps, update); progress.update(update); }
          return;
        }
        if (message?.type === 'account' && slots.includes(message.slot) && ['usage limit reached', 'account not eligible'].includes(message.kind)) {
          void this.accountLimited(message.slot, message.kind); return;
        }
        // The provider may be any slot of the pool; model and thinking must match exactly.
        if (message?.type !== 'runtime' || !runtimeMatches(message.runtime, pinned) || !slots.includes(message.runtime.provider)) { stop('Pi runtime identity mismatch'); return; }
        observed = message.runtime;
        save(file, { ...receipt, commit, runtime: observed });
        } catch { stop('Run state persistence failed'); }
      });
      child.stdout.on('data', b => { bytes += b.length; if (bytes > 262144) stop('Result limit exceeded'); else output += b; });
      child.stderr.resume();
      let finished = false;
      const done = async code => {
        if (finished) return; finished = true;
        clearInterval(diskTimer);
        let result = {};
        try { result = JSON.parse(output || '{}'); } catch { failure ??= 'Invalid Pi result'; }
        if (code !== 0 && !result.error) failure ??= 'Pi process exited';
        if (code === 0 && !failure && (!observed || !runtimeMatches(result.runtime, { ...runtime, provider: observed.provider }))) failure = 'Missing verified Pi runtime';
        if (write && code === 0 && !failure && !result.error) {
          receipt.progress = { ...receipt.progress, phase: 'export', action: 'export_started', observed_at: new Date().toISOString(), blocker: undefined };
          appendStep(receipt.progress_steps, receipt.progress);
          progress.update(receipt.progress);
          try { harvested = await this.harvest(policy, receipt, baseCommit, repository); commit = harvested.commit;
            save(path.join(recoveryDir, 'export.json'), harvested); }
          catch (error) { failure = /^[A-Za-z0-9 ;:.,_-]{1,180}$/.test(error.message) ? error.message : 'Export failed'; }
        }
        await finish(code, result);
      };
      child.on('error', () => { failure ??= 'Pi process could not start'; void done(1).catch(() => this.finalizationFailed(receipt)); });
      child.on('close', code => void done(code).catch(() => this.finalizationFailed(receipt))); child.stdin.on('error', () => {}); child.stdin.end(receipt.task);
    } catch (error) {
      failure ??= /^[A-Za-z0-9 ;:.,_-]{1,180}$/.test(error.message) ? error.message : 'Run preparation failed';
      await finish(1);
    }
  }
  finalizationFailed(receipt) {
    // A storage failure must not become an unhandled rejection that kills other runs.
    this.runs.delete(receipt.run_id);
    try {
      const file = path.join(this.state, 'agent-runs', receipt.run_id + '.json');
      const saved = read(file);
      if (saved.status === 'running') save(file, { ...saved, recovery: this.recoveryInfo(receipt.run_id).info, status: 'interrupted', ended: new Date().toISOString(),
        error: 'Run finalization failed; retained work requires recovery' });
    } catch { /* Existing running receipt and workspace remain for startup reconciliation. */ }
    void this.report(receipt.run_id);
  }
  // After a write run: commit and bundle inside the sandbox (the checkout's git config is agent-controlled),
  // then import the bundle into the bare repository as an append-only review ref.
  async harvest(policy, receipt, base, repository) {
    const run = receipt.run_id, exportRef = 'refs/heads/export-' + run, filename = '.git/review-' + run + '.bundle';
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('No base commit');
    const git = 'git -c core.hooksPath=/dev/null';
    const script = ['set -e', `${git} add -A`,
      `${git} diff --cached --quiet || ${git} -c user.name=dok-agent -c user.email=agent@dok.invalid commit -q -m "Agents Hub run ${run}"`,
      `${git} merge-base --is-ancestor ${base} HEAD`,
      `if [ "$(${git} rev-parse HEAD)" = ${base} ]; then echo unchanged; else ${git} update-ref ${exportRef} HEAD && ${git} bundle create ${filename} ${exportRef} ^${base} >/dev/null 2>&1 && echo bundled; fi`].join('\n');
    const result = await sandboxExecute(policy, 'bash', { command: script });
    const text = result?.content?.find(c => c.type === 'text')?.text ?? '';
    if (/\bunchanged\s*$/.test(text)) return { commit: base, changed_files: [] };
    if (!/\bbundled\s*$/.test(text)) throw new Error('Run did not produce an exportable result');
    const imported = this.importBundle({ workspace: policy.workspace, filename, id: run, exportRef, ref: 'refs/heads/review/runs/' + run, repository });
    const names = execFileSync('git', ['--git-dir', repository, 'diff', '--name-only', '-z', base, imported.commit], { env: gitEnv, encoding: 'utf8', timeout: 15000 })
      .split('\0').filter(n => n && n.length <= 300 && !/[\r\n]/.test(n)).slice(0, 200);
    return { commit: imported.commit, review_ref: imported.ref, changed_files: names };
  }
  // Keep the newest few write conversations for a week; read runs and everything else is removed.
  prune() {
    const dir = path.join(this.state, 'run-work'), live = new Set([...this.runs.keys()].map(id => this.runRoot(id)));
    const unresolved = new Set(fs.readdirSync(path.join(this.state, 'agent-runs')).flatMap(name => {
      try { const r = read(path.join(this.state, 'agent-runs', name)); return r.status !== 'completed' ? [r.root ?? r.run_id] : []; } catch { return fs.readdirSync(dir); }
    }));
    const items = fs.readdirSync(dir).filter(n => !live.has(n) && !unresolved.has(n)).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    items.forEach(({ n, t }, i) => { if (i >= this.limits.keepConversations || Date.now() - t > this.limits.keepMs) fs.rmSync(path.join(dir, n), { recursive: true, force: true }); });
  }
  runRoot(runId) { try { return read(path.join(this.state, 'agent-runs', runId + '.json')).root ?? runId; } catch { return runId; } }
  // Account pool: skip slots another runner (or an earlier run) found at their limit; Hub state is shared.
  async poolSlots(now = Date.now()) {
    let states = [];
    try { states = (await this.accounts?.get()) ?? []; } catch { /* Hub unreachable: try every slot */ }
    const blocked = new Map(states.filter(a => a.state !== 'ok' && a.until && Date.parse(a.until) > now).map(a => [a.slot, a.until]));
    const open = this.limits.slots.filter(slot => !blocked.has(slot));
    if (!open.length) throw new Error(`All accounts are at their limit until ${[...blocked.values()].sort()[0]}`);
    return open;
  }
  async accountLimited(slot, kind) {
    if (!this.limits.slots.includes(slot)) return;
    const disabled = kind === 'account not eligible';
    const until = new Date(Date.now() + (disabled ? this.limits.disableMs : this.limits.cooldownMs)).toISOString();
    try { await this.accounts?.post({ slot, state: disabled ? 'disabled' : 'cooldown', until, last_error_kind: kind }); } catch { /* best effort */ }
  }
  // Receipts go to the Hub when they change; unreported final receipts are retried by flushReports.
  async report(runId) {
    if (!this.reporter) return;
    const file = path.join(this.state, 'agent-runs', runId + '.json');
    try {
      const receipt = this.runGet(runId);
      await this.reporter(receipt);
      const current = read(file);
      if (receipt.status !== 'running' && current.status === receipt.status && current.recovery?.revision === receipt.recovery?.revision) save(file, { ...current, reported_at: Date.now() });
    } catch { /* retried by flushReports */ }
  }
  async flushReports() {
    for (const name of fs.readdirSync(path.join(this.state, 'agent-runs'))) {
      const r = read(path.join(this.state, 'agent-runs', name));
      if (r.status !== 'running' && !r.reported_at) await this.report(r.run_id);
    }
  }
  // Quarantine a bundle the sandbox produced and add one append-only ref from it (no force, no checkout, no hooks).
  importBundle({ workspace, filename, id, exportRef, ref, repository = this.repository, expected }) {
    const candidate = fs.realpathSync(path.join(workspace, filename));
    if (!candidate.startsWith(workspace + path.sep)) throw new Error('Invalid export path');
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const target = path.join(this.state, 'quarantine', id + '.bundle');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 ** 2) throw new Error('Export exceeds 64 MiB limit');
      if (!fs.existsSync(target)) fs.writeFileSync(target, fs.readFileSync(fd), { mode: 0o400, flag: 'wx' });
    } finally { fs.closeSync(fd); }
    const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', '--git-dir', repository];
    // No plus/force: existing review refs cannot be replaced. No checkout or hooks.
    execFileSync('git', [...args, 'bundle', 'verify', target], { env: gitEnv, stdio: 'pipe' });
    const head = execFileSync('git', [...args, 'bundle', 'list-heads', target, exportRef], { env: gitEnv, timeout: 15000, encoding: 'utf8' }).split(' ')[0];
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Bundle has no matching head');
    if (expected && head !== expected) throw new Error('Bundle does not match task commit');
    try {
      const existing = execFileSync('git', [...args, 'rev-parse', '--verify', ref], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (existing !== head) throw new Error('Review ref already exists with different content');
      return { ref, commit: head };
    } catch (error) { if (error.message === 'Review ref already exists with different content') throw error; }
    execFileSync('git', [...args, 'fetch', '--no-tags', '--no-write-fetch-head', target, `${exportRef}:${ref}`], { env: gitEnv, timeout: 15000, stdio: 'pipe' });
    return { ref, commit: head };
  }
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
    return this.importBundle({ workspace: config.policy.workspace, filename, id: run_id, exportRef, ref: `refs/heads/review/${conversation_id}/${run_id}`, expected: receipt.commit });
    } finally {
      this.active = null;
      try { await this.lease({ grant_id, process_session: this.processSession, policy_digest, execution_state: 'stopped' }); } catch {}
    }
  }
}
