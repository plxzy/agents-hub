import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Writable runs keep the agent's shell offline, so dependencies are restored first from the committed lockfile only.
// The supervisor downloads the exact registry tarballs as bytes (checked against the lockfile's integrity, never
// executed); the existing offline sandbox then installs from them with --offline --ignore-scripts. No sandbox gets network.
const REGISTRY = 'https://registry.npmjs.org/';
const SAFE_SEGMENT = /[\w@-][\w.@-]*/;
const SAFE_DIR = new RegExp(`^(\\.|${SAFE_SEGMENT.source}|.devcontainer|${SAFE_SEGMENT.source}/(${SAFE_SEGMENT.source}|.devcontainer)|.devcontainer/${SAFE_SEGMENT.source})$`);
/** Directories (root and up to two levels down) that hold one of the marker files. Toolchain dot-folders
 * (.devcontainer) are part of the search; VCS internals and arbitrary hidden dirs are not. */
const SKIP = new Set(['node_modules', '.git']);
function dirsWith(workspace, markers) {
  const found = [];
  const walk = (rel, depth) => {
    const dir = path.join(workspace, rel);
    if (markers.some(name => fs.existsSync(path.join(dir, name)))) found.push(rel || '.');
    if (depth === 0) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name) && (!e.name.startsWith('.') || e.name === '.devcontainer')) walk(path.join(rel, e.name), depth - 1);
  };
  walk('', 2);
  return found;
}

/** Directories (root and up to two levels down) that hold a package-lock.json. */
export function lockfileDirs(workspace) {
  return dirsWith(workspace, ['package-lock.json']);
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

// npm skips optional packages whose os/cpu/libc do not match, so their tarballs are never needed (workerd ships one per platform).
const fits = (list, value) => !Array.isArray(list) || (!list.includes('!' + value) && (list.every(x => x.startsWith('!')) || list.includes(value)));
export const needed = (e, { platform = process.platform, arch = process.arch } = {}) => !e.optional || (fits(e.os, platform) && fits(e.cpu, arch) && (platform !== 'linux' || fits(e.libc, 'glibc')));

const MAX_TARBALL = 200 * 1024 ** 2, MAX_TOTAL = 1024 ** 3;

/** Download every locked tarball into state/deps/<lock hash>/ (skipped when already cached). Returns that directory. */
export async function fetchTarballs(workspace, rel, state, { fetchImpl = fetch, platform, arch } = {}) {
  const raw = fs.readFileSync(path.join(workspace, rel, 'package-lock.json'));
  const dir = path.join(state, 'deps', createHash('sha256').update(raw).digest('hex'));
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;
  const tmp = dir + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  // The same tarball can sit under several lockfile paths (nested copies); fetch each URL once.
  const seen = new Set();
  const entries = Object.entries(JSON.parse(raw).packages).filter(([name, e]) => name && !e.link && needed(e, { platform, arch }) && !seen.has(e.resolved) && seen.add(e.resolved));
  let total = 0, next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [name, e] = entries[next++], url = new URL(e.resolved);
      if (url.protocol !== 'https:' || url.host !== 'registry.npmjs.org') throw new Error('Refusing source for ' + name);
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(600_000) });
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
  if (!dirs.length) return { ...result, python: await installPython({ workspace, state, agent, io, fetchImpl }) };
  const base = io.linuxPolicy({ ...agent, workspace, writePaths: [workspace], protectPaths: [], skills: [], context: null }, state);
  for (const rel of dirs) {
    const reason = untrusted(workspace, rel);
    if (reason) { result.skipped.push({ dir: rel, reason }); continue; }
    try {
      const tarballs = fs.realpathSync(await fetchTarballs(workspace, rel, state, { fetchImpl }));
      const policy = { ...base, readonly: [...(base.readonly ?? []), tarballs], timeout_ms: 600_000 };
      const keep = path.posix.join(rel, 'node_modules');
      const command = `cd ${rel} && npm cache add ${tarballs}/*.tgz --ignore-scripts >/dev/null && `
        + 'npm ci --offline --ignore-scripts --no-audit --no-fund && '
        + `cd ${path.relative(rel, '.') || '.'} && mkdir -p .git/info && `
        + `{ grep -qx '${keep}' .git/info/exclude 2>/dev/null || echo '${keep}' >> .git/info/exclude; }`;
      await io.sandboxExecute(policy, 'bash', { command });
      result.installed.push(rel);
    } catch (error) { result.skipped.push({ dir: rel, reason: 'install failed: ' + String(error.message).slice(0, 300) }); }
  }
  return { ...result, python: await installPython({ workspace, state, agent, io, fetchImpl }) };
}

// Python mirrors npm: hashed requirements files are the lockfiles. The supervisor downloads the pinned PyPI
// artifacts as bytes (checked against every --hash in the file, never executed); the same offline sandbox then
// installs them with --no-index --require-hashes into a per-project .deps-python directory.
const PY_MARKERS = ['python-requirements.txt', 'requirements.txt', 'requirements-dev.txt'];
/** Sorted marker names so each directory lists its requirements files in a stable order. */
const PY_SORTED = [...PY_MARKERS].sort();
const PY_HASH = /^--hash=sha256:[0-9a-f]{64}$/;
const PY_REQ = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9._+!-]*)$/;
const normalizeName = name => name.toLowerCase().replace(/[-_.]+/g, '-');

/** { dir, file } pairs (root and up to two levels down) that hold a hashed pip requirements file. */
export function requirementsFiles(workspace) {
  const found = [];
  for (const rel of dirsWith(workspace, PY_MARKERS))
    for (const name of PY_SORTED) {
      const file = path.join(workspace, rel, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) found.push({ dir: rel || '.', file: name });
    }
  return found;
}

/** Parsed pins, or the reason this requirements file cannot be restored without network. */
export function parseRequirements(workspace, rel, name) {
  if (!SAFE_DIR.test(rel) || !SAFE_DIR.test(name)) return { reason: 'unsafe path name' };
  let lines;
  try { lines = fs.readFileSync(path.join(workspace, rel, name), 'utf8').split('\n'); } catch { return { reason: 'unreadable requirements file' }; }
  const pins = [], errors = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim(); // full-line comments and trailing comments
    if (!line) continue;
    const fields = line.split(/[ \t\\]+/).filter(Boolean);
    const match = fields[0].match(PY_REQ);
    const hashes = fields.slice(1).filter(f => f.startsWith('--hash='));
    if (!match) { errors.push('unpinned line: ' + fields[0].slice(0, 60)); continue; }
    if (!hashes.length || hashes.length !== fields.length - 1 || !hashes.every(h => PY_HASH.test(h))) { errors.push('bad hash: ' + match[1]); continue; }
    pins.push({ name: match[1], version: match[2], hashes: new Set(hashes.map(h => h.slice('--hash=sha256:'.length))) });
  }
  if (errors.length) return { reason: errors.slice(0, 2).join('; ') };
  if (!pins.length) return { reason: 'no pinned requirements' };
  return { pins };
}

const MAX_WHEEL = 200 * 1024 ** 2, MAX_PY_TOTAL = 1024 ** 3;

/** The candidates an offline py3 install can use: non-yanked pure wheels (resolver preference) and sdists. */
function candidateFiles(data) {
  const files = (data?.urls ?? []).filter(f => !f?.yanked && typeof f?.digests?.sha256 === 'string');
  return {
    wheels: files.filter(f => f.packagetype === 'bdist_wheel' && /-(py3|py2\.py3)-none-any\.whl$/.test(f.filename)),
    sdists: files.filter(f => f.packagetype === 'sdist'),
  };
}

/** Download every pinned artifact into state/deps-py/<requirements hash>/ (skipped when already cached). Returns that directory. */
export async function fetchWheels(workspace, rel, name, state, { fetchImpl = fetch, indexUrl = 'https://pypi.org/pypi' } = {}) {
  const { pins, reason } = parseRequirements(workspace, rel, name);
  if (reason) throw new Error('untrusted requirements: ' + reason);
  const raw = fs.readFileSync(path.join(workspace, rel, name));
  const dir = path.join(state, 'deps-py', createHash('sha256').update(raw).digest('hex'));
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;
  const tmp = dir + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  let total = 0;
  try {
    for (const pin of pins) {
      const metaUrl = `${indexUrl}/${encodeURIComponent(normalizeName(pin.name))}/${encodeURIComponent(pin.version)}/json`;
      const meta = await fetchImpl(metaUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      if (!meta.ok) throw new Error(`Registry ${meta.status} for ${pin.name}`);
      const { wheels, sdists } = candidateFiles(await meta.json());
      const known = f => pin.hashes.has(f.digests.sha256);
      const chosen = wheels.find(known) ?? sdists.find(known) ?? null;
      if (!chosen) throw new Error('No pinned artifact for ' + pin.name);
      const fileUrl = new URL(chosen.url);
      if (fileUrl.protocol !== 'https:' || fileUrl.host !== 'files.pythonhosted.org') throw new Error('Refusing source for ' + pin.name);
      const response = await fetchImpl(fileUrl, { redirect: 'error', signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`Registry ${response.status} for ${pin.name}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      total += bytes.length;
      if (bytes.length > MAX_WHEEL || total > MAX_PY_TOTAL) throw new Error('Dependency download too large');
      if (!pin.hashes.has(createHash('sha256').update(bytes).digest('hex'))) throw new Error('Hash mismatch for ' + pin.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._!+~-]*\.(whl|tar\.gz|zip)$/.test(chosen.filename)) throw new Error('Unsafe filename for ' + pin.name);
      fs.writeFileSync(path.join(tmp, chosen.filename), bytes, { mode: 0o400 });
    }
    fs.writeFileSync(path.join(tmp, '.complete'), '');
  } catch (error) { fs.rmSync(tmp, { recursive: true, force: true }); throw error; }
  try { fs.renameSync(tmp, dir); } catch { fs.rmSync(tmp, { recursive: true, force: true }); } // a concurrent run won
  return dir;
}

/**
 * Restore every trusted requirements file in the clone, then keep the installed trees out of the review commit.
 * The sandbox that runs pip has no network: it only sees the cached wheels, read-only. Never throws.
 */
export async function installPython({ workspace, state, agent, io, fetchImpl }) {
  const result = { installed: [], skipped: [] };
  const files = requirementsFiles(workspace);
  if (!files.length) return result;
  const base = io.linuxPolicy({ ...agent, workspace, writePaths: [workspace], protectPaths: [], skills: [], context: null }, state);
  for (const { dir: rel, file } of files) {
    const { reason } = parseRequirements(workspace, rel, file);
    if (reason) { result.skipped.push({ dir: rel, requirements: file, reason }); continue; }
    try {
      const wheels = fs.realpathSync(await fetchWheels(workspace, rel, file, state, { fetchImpl }));
      const policy = { ...base, readonly: [...(base.readonly ?? []), wheels], timeout_ms: 600_000 };
      const keep = path.posix.join(rel, '.deps-python');
      const command = 'set -e; '
        + 'unset PYTHONHOME; export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 TMPDIR=/tmp XDG_CACHE_HOME=/tmp/pip-cache; umask 022; '
        + `cd ${rel} && rm -rf .deps-python && env -u PYTHONPATH python3 -m pip install --no-index --find-links ${wheels} --require-hashes -r ${file} --target .deps-python && `
        + `cd ${path.relative(rel, '.') || '.'} && mkdir -p .git/info && `
        + `grep -qx '${keep}' .git/info/exclude 2>/dev/null || echo '${keep}' >> .git/info/exclude`;
      await io.sandboxExecute(policy, 'bash', { command });
      result.installed.push({ dir: rel, requirements: file });
    } catch (error) { result.skipped.push({ dir: rel, requirements: file, reason: 'install failed: ' + String(error.message).slice(0, 300) }); }
  }
  return result;
}
