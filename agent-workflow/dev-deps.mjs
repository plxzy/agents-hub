import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Writable runs keep the agent's shell offline, so dependencies are restored first from the committed lockfile only.
// The supervisor downloads the exact registry tarballs as bytes (checked against the lockfile's integrity, never
// executed); the existing offline sandbox then installs from them with --offline --ignore-scripts. No sandbox gets network.
const REGISTRY = 'https://registry.npmjs.org/';
const SAFE_DIR = /^(\.|[\w@-][\w.@-]*(\/[\w@-][\w.@-]*)?)$/;
const SKIP = new Set(['node_modules', '.git']);

/** Directories (root and up to two levels down) that hold a package-lock.json. */
export function lockfileDirs(workspace) {
  const found = [];
  const walk = (rel, depth) => {
    const dir = path.join(workspace, rel);
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) found.push(rel || '.');
    if (depth === 0) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(rel, e.name), depth - 1);
  };
  walk('', 2);
  return found;
}

/** Why a directory must not be installed, or null when its lockfile only names public registry tarballs. */
export function untrusted(workspace, rel) {
  const dir = path.join(workspace, rel);
  if (!SAFE_DIR.test(rel)) return 'unsafe directory name';
  if (fs.existsSync(path.join(dir, '.npmrc')) || fs.existsSync(path.join(workspace, '.npmrc'))) return 'project .npmrc';
  let lock, manifest = fs.existsSync(path.join(dir, 'package.json'));
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')); } catch { return 'unreadable lockfile'; }
  if (!manifest) return 'no package.json';
  if (!(lock.lockfileVersion >= 2) || typeof lock.packages !== 'object' || !lock.packages) return 'lockfile older than v2';
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === '' || entry.link) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) return 'non-registry source: ' + name;
    if (typeof entry.integrity !== 'string') return 'missing integrity: ' + name;
  }
  return null;
}

const MAX_TARBALL = 200 * 1024 ** 2, MAX_TOTAL = 1024 ** 3;

/** Download every locked tarball into state/deps/<lock hash>/ (skipped when already cached). Returns that directory. */
export async function fetchTarballs(workspace, rel, state, { fetchImpl = fetch } = {}) {
  const raw = fs.readFileSync(path.join(workspace, rel, 'package-lock.json'));
  const dir = path.join(state, 'deps', createHash('sha256').update(raw).digest('hex'));
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;
  const tmp = dir + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const entries = Object.entries(JSON.parse(raw).packages).filter(([name, e]) => name && !e.link);
  let total = 0, next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [name, e] = entries[next++], url = new URL(e.resolved);
      if (url.protocol !== 'https:' || url.host !== 'registry.npmjs.org') throw new Error('Refusing source for ' + name);
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Registry ${response.status} for ${name}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      total += bytes.length;
      if (bytes.length > MAX_TARBALL || total > MAX_TOTAL) throw new Error('Dependency download too large');
      const [algo, digest] = e.integrity.split('-');
      if (!['sha512', 'sha384', 'sha256'].includes(algo) || createHash(algo).update(bytes).digest('base64') !== digest) throw new Error('Integrity mismatch for ' + name);
      fs.writeFileSync(path.join(tmp, createHash('sha256').update(e.resolved).digest('hex') + '.tgz'), bytes, { mode: 0o400 });
    }
  };
  try { await Promise.all(Array.from({ length: 8 }, worker)); fs.writeFileSync(path.join(tmp, '.complete'), ''); }
  catch (error) { fs.rmSync(tmp, { recursive: true, force: true }); throw error; }
  try { fs.renameSync(tmp, dir); } catch { fs.rmSync(tmp, { recursive: true, force: true }); } // a concurrent run won
  return dir;
}

/**
 * Restore every trusted lockfile in the clone, then keep node_modules out of the review commit. The sandbox that
 * runs npm has no network: it only sees the cached tarballs, read-only. Never throws: a failed install is
 * reported and the run goes on.
 */
export async function installDependencies({ workspace, state, agent, io, fetchImpl }) {
  const result = { installed: [], skipped: [] };
  const dirs = lockfileDirs(workspace);
  if (!dirs.length) return result;
  const base = io.linuxPolicy({ ...agent, workspace, writePaths: [workspace], protectPaths: [], skills: [], context: null }, state);
  for (const rel of dirs) {
    const reason = untrusted(workspace, rel);
    if (reason) { result.skipped.push({ dir: rel, reason }); continue; }
    try {
      const tarballs = fs.realpathSync(await fetchTarballs(workspace, rel, state, { fetchImpl }));
      const policy = { ...base, readonly: [...(base.readonly ?? []), tarballs], timeout_ms: 600_000 };
      const keep = path.join(rel, 'node_modules');
      const command = `cd ${rel} && npm cache add ${tarballs}/*.tgz --ignore-scripts >/dev/null && `
        + 'npm ci --offline --ignore-scripts --no-audit --no-fund && '
        + `cd ${path.relative(rel, '.') || '.'} && mkdir -p .git/info && `
        + `{ grep -qx '${keep}' .git/info/exclude 2>/dev/null || echo '${keep}' >> .git/info/exclude; }`;
      await io.sandboxExecute(policy, 'bash', { command });
      result.installed.push(rel);
    } catch (error) { result.skipped.push({ dir: rel, reason: 'install failed: ' + String(error.message).slice(0, 300) }); }
  }
  return result;
}
