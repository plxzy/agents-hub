import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const names = ['linux-sandbox.mjs', 'linux-worker.mjs', 'linux-tools.ts'];
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);

// A bwrap sandbox has an empty root: nothing defines /etc/passwd, so the sandbox uid fails
// pwd.getpwuid()/os.path.expanduser('~')/getpass.getuser(). bwrap maps the invoking uid:gid
// one-to-one into its user namespace (1000:1000 for the runner's `agent` user uid on dok; uid 0
// when invoked as root, e.g. local acceptance containers), so the table names each mapping the
// policy can produce under the same synthetic identity. The identity is frozen in the release
// (the hash covers it) rather than exposing host /etc/passwd or its hashes. /home/agent is only
// the directory the passwd entry records; nothing is mounted there.
export const SANDBOX_IDENTITY = {
  // uid 0: acceptance containers invoke bwrap as root. uid 1000: dok's `agent` container user (bwrap maps
  // the invoking uid into its user namespace unchanged). 65534 is a defensive fallback. Both real runners
  // land on the `sandbox` record, so `getpass.getuser()`, `pwd.getpwuid()` and `expanduser('~')` resolve
  // to the same user regardless of which mapping a suite happens to run under.
  '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\n'
    + 'sandbox:x:1000:1000:Linux workflow sandbox:/home/agent:/bin/sh\n'
    + 'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n',
  '/etc/group': 'root:x:0:\nsandbox:x:1000:\nnogroup:x:65534:\n',
};
const identityNames = Object.keys(SANDBOX_IDENTITY).sort();

export function freezeLinuxTools(state) {
  const files = [
    ...names.map(name => [name, fs.readFileSync(path.join(source, name))]),
    ...identityNames.map(name => [path.join('sandbox-identity', path.basename(name)), Buffer.from(SANDBOX_IDENTITY[name])]),
  ];
  const revision = createHash('sha256').update(Buffer.concat(files.flatMap(([n, b]) => [Buffer.from(n + '\0'), b]))).digest('hex');
  const dir = path.join(state, 'tool-releases', revision);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, data] of files) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(data)) throw new Error('Frozen tool release changed');
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, data, { flag: 'wx', mode: 0o400 });
    }
  }
  return { dir, revision };
}

export function linuxPolicy(agent, state, { readOnly = false } = {}) {
  const workspace = fs.realpathSync(agent.workspace);
  // A whole-workspace mount must never broaden a here_write or read-only agent.
  // Read-only runs instead mount the workspace read-only and never get write tools.
  if (!readOnly && !(agent.writePaths ?? []).some(p => {
    try { return inside(fs.realpathSync(p), workspace); } catch { return false; }
  })) throw new Error('Linux execution requires an explicitly writable whole workspace');
  const { dir, revision } = freezeLinuxTools(state);
  if (inside(workspace, dir)) throw new Error('Trusted tool release must be outside the workspace');
  const result = spawnSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Pi is not on PATH');
  const binary = fs.realpathSync(result.stdout.trim());
  let packageDir = path.dirname(binary);
  while (packageDir !== path.dirname(packageDir) && !fs.existsSync(path.join(packageDir, 'package.json'))) packageDir = path.dirname(packageDir);
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== '1.3.0') throw new Error('Linux tools require the pinned Pi 1.3.0 release');
  // Include the dependency tree, not the containing home directory.
  const runtime = path.resolve(packageDir, '../..');
  if (inside(workspace, runtime)) throw new Error('Pi runtime must be outside the workspace');
  const protectedPaths = [...(agent.protectPaths ?? [])];
  const evidence = path.join(workspace, 'evidence');
  if (fs.existsSync(evidence)) for (const name of fs.readdirSync(evidence)) protectedPaths.push(path.join(evidence, name));
  for (const name of ['space-mirror', '.context']) protectedPaths.push(path.join(workspace, name));
  // Restored Python dependencies (dev-deps installs each hashed requirements file into a sibling .deps-python)
  // import without any per-repo wiring: every existing .deps-python near the root joins the sandbox PYTHONPATH.
  // The scan includes .devcontainer, whose toolchain pins other dot-directory rules skip.
  const depsPython = [];
  const scan = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.deps-python'))) depsPython.push(path.join(dir, '.deps-python'));
    if (depth === 0) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries)
      if (e.isDirectory() && !e.isSymbolicLink() && !['node_modules', '.git'].includes(e.name) && (!e.name.startsWith('.') || e.name === '.devcontainer'))
        scan(path.join(dir, e.name), depth - 1);
  };
  scan(workspace, 2);
  return { workspace, ...(readOnly ? { readonly_workspace: true } : {}), release: dir, release_revision: revision, runtime,
    sdk: path.join(packageDir, 'dist/index.js'), timeout_ms: 600_000, output_bytes: 1_048_576, pythonpath: depsPython.length ? depsPython.join(':') : undefined,
    readonly: [...(agent.skills === 'none' ? [] : agent.skills ?? []), ...(agent.context ? [agent.context] : [])].map(p => fs.realpathSync(p)).filter(p => !inside(workspace, p)),
    protected: protectedPaths.filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)).filter(p => inside(workspace, p)) };
}

export function sandboxArgs(policy) {
  for (const key of ['workspace', 'release', 'runtime', 'sdk']) if (!path.isAbsolute(policy[key] ?? '')) throw new Error('Invalid sandbox path');
  if (inside(policy.workspace, policy.release) || inside(policy.workspace, policy.runtime)) throw new Error('Writable trusted runtime');
  return ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/opt', '/opt', '--ro-bind', '/usr/lib', '/usr/lib',
    // ffmpeg's libraries resolve through Debian's /etc/alternatives; the bwrap root has no /etc.
    // Mount the symlink tree only (20 links into /usr/lib), never the whole /etc.
    '--ro-bind', '/etc/alternatives', '/etc/alternatives',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    // A fresh procfs belongs to --unshare-all's PID namespace; never bind the host's /proc.
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', '/tmp/home',
    // The home the passwd entry records for stripped-environment lookups (HOME=/tmp/home wins when set).
    '--dir', '/home/agent',
    ...identityNames.flatMap(name => ['--ro-bind', path.join(policy.release, 'sandbox-identity', path.basename(name)), name]),
    policy.readonly_workspace ? '--ro-bind' : '--bind', policy.workspace, policy.workspace,
    '--ro-bind', policy.release, policy.release, '--ro-bind', policy.runtime, policy.runtime,
    ...(policy.readonly ?? []).flatMap(p => ['--ro-bind', p, p]),
    ...policy.protected.flatMap(p => ['--ro-bind', p, p]),
    '--setenv', 'HOME', '/tmp/home', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', '/home/agent/.local/bin:/opt/node-vm/bin:/usr/local/bin:/usr/bin:/bin',
    ...(policy.pythonpath ? ['--setenv', 'PYTHONPATH', policy.pythonpath] : []),
    '--setenv', 'GIT_CONFIG_NOSYSTEM', '1', '--setenv', 'GIT_CONFIG_GLOBAL', '/dev/null',
    '--setenv', 'GIT_AUTHOR_NAME', 'Workflow agent', '--setenv', 'GIT_AUTHOR_EMAIL', 'workflow@localhost',
    '--setenv', 'GIT_COMMITTER_NAME', 'Workflow agent', '--setenv', 'GIT_COMMITTER_EMAIL', 'workflow@localhost',
    '--chdir', policy.workspace, '--', '/usr/local/bin/node', path.join(policy.release, 'linux-worker.mjs'), policy.sdk];
}

export function sandboxExecute(policy, tool, args, { signal, spawnImpl = spawn } = {}) {
  if (!['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'].includes(tool)) throw new Error('Unknown sandbox tool');
  if (policy.readonly_workspace && ['edit', 'write'].includes(tool)) throw new Error('Read-only run cannot write');
  return new Promise((resolve, reject) => {
    const child = spawnImpl('bwrap', sandboxArgs(policy), { stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    let output = '', errors = '', count = 0, failure, done = false;
    const stop = reason => {
      failure ??= new Error(reason);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const abort = () => stop('Sandbox tool aborted');
    const timer = setTimeout(() => stop('Sandbox tool exceeded time limit'), policy.timeout_ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { count += chunk.length; if (count > policy.output_bytes) stop('Sandbox output limit exceeded'); else output += chunk; });
    child.stderr.on('data', chunk => { if (errors.length < 8192) errors += chunk.toString().slice(0, 8192 - errors.length); });
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error || failure) { reject(failure || error); return; }
      try { const value = JSON.parse(output); if (value.error) throw new Error(value.error); resolve(value.result); }
      catch (e) { reject(new Error('Sandbox failed: ' + (errors || e.message))); }
    };
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error('Sandbox exited ' + code + ': ' + errors)));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ tool, args }));
  });
}
