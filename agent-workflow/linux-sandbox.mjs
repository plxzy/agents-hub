import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const names = ['linux-sandbox.mjs', 'linux-worker.mjs', 'linux-tools.ts'];
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);

export function freezeLinuxTools(state) {
  const files = names.map(name => [name, fs.readFileSync(path.join(source, name))]);
  const revision = createHash('sha256').update(Buffer.concat(files.flatMap(([n, b]) => [Buffer.from(n + '\0'), b]))).digest('hex');
  const dir = path.join(state, 'tool-releases', revision);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, data] of files) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(data)) throw new Error('Frozen tool release changed');
    } else fs.writeFileSync(file, data, { flag: 'wx', mode: 0o400 });
  }
  return { dir, revision };
}

export function linuxPolicy(agent, state) {
  const workspace = fs.realpathSync(agent.workspace);
  // A whole-workspace mount must never broaden a here_write or read-only agent.
  if (!(agent.writePaths ?? []).some(p => {
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
  if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== '1.1.0') throw new Error('Linux tools require the pinned Pi 1.1.0 release');
  // Include the dependency tree, not the containing home directory.
  const runtime = path.resolve(packageDir, '../..');
  if (inside(workspace, runtime)) throw new Error('Pi runtime must be outside the workspace');
  const protectedPaths = [...(agent.protectPaths ?? [])];
  const evidence = path.join(workspace, 'evidence');
  if (fs.existsSync(evidence)) for (const name of fs.readdirSync(evidence)) protectedPaths.push(path.join(evidence, name));
  for (const name of ['space-mirror', '.context']) protectedPaths.push(path.join(workspace, name));
  return { workspace, release: dir, release_revision: revision, runtime,
    sdk: path.join(packageDir, 'dist/index.js'), timeout_ms: 600_000, output_bytes: 1_048_576,
    readonly: [...(agent.skills === 'none' ? [] : agent.skills ?? []), ...(agent.context ? [agent.context] : [])].map(p => fs.realpathSync(p)).filter(p => !inside(workspace, p)),
    protected: protectedPaths.filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)).filter(p => inside(workspace, p)) };
}

export function sandboxArgs(policy) {
  for (const key of ['workspace', 'release', 'runtime', 'sdk']) if (!path.isAbsolute(policy[key] ?? '')) throw new Error('Invalid sandbox path');
  if (inside(policy.workspace, policy.release) || inside(policy.workspace, policy.runtime)) throw new Error('Writable trusted runtime');
  return ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/opt', '/opt',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--dev', '/dev', '--dir', '/proc', '--tmpfs', '/tmp', '--dir', '/tmp/home',
    '--bind', policy.workspace, policy.workspace,
    '--ro-bind', policy.release, policy.release, '--ro-bind', policy.runtime, policy.runtime,
    ...(policy.readonly ?? []).flatMap(p => ['--ro-bind', p, p]),
    ...policy.protected.flatMap(p => ['--ro-bind', p, p]),
    '--setenv', 'HOME', '/tmp/home', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', '/opt/node-vm/bin:/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'GIT_CONFIG_NOSYSTEM', '1', '--setenv', 'GIT_CONFIG_GLOBAL', '/dev/null',
    '--setenv', 'GIT_AUTHOR_NAME', 'Workflow agent', '--setenv', 'GIT_AUTHOR_EMAIL', 'workflow@localhost',
    '--setenv', 'GIT_COMMITTER_NAME', 'Workflow agent', '--setenv', 'GIT_COMMITTER_EMAIL', 'workflow@localhost',
    '--chdir', policy.workspace, '--', '/usr/local/bin/node', path.join(policy.release, 'linux-worker.mjs'), policy.sdk];
}

export function sandboxExecute(policy, tool, args, { signal, spawnImpl = spawn } = {}) {
  if (!['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'].includes(tool)) throw new Error('Unknown sandbox tool');
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
