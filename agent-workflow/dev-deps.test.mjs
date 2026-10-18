import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lockfileDirs, untrusted, fetchTarballs, installDependencies, needed, requirementsFiles, parseRequirements, fetchWheels, installPython } from './dev-deps.mjs';

const bytes = Buffer.from('synthetic tarball');
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const resolved = 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz';
function fixture(t, lock = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-deps-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'ws'), state = path.join(root, 'state'); fs.mkdirSync(workspace); fs.mkdirSync(state);
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  fs.writeFileSync(path.join(workspace, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/demo': { resolved, integrity }, ...lock } }));
  return { workspace, state };
}
const ok = async () => new Response(bytes);

test('lockfile gate accepts public registry sources and refuses everything else', t => {
  const f = fixture(t);
  assert.deepEqual(lockfileDirs(f.workspace), ['.']);
  assert.equal(untrusted(f.workspace, '.'), null);
  for (const [lock, reason] of [
    [{ 'node_modules/x': { resolved: 'git+https://example.test/x.git', integrity } }, /non-registry/],
    [{ 'node_modules/x': { resolved: 'https://evil.example/x.tgz', integrity } }, /non-registry/],
    [{ 'node_modules/x': { resolved } }, /integrity/]]) {
    const g = fixture(t, lock); assert.match(untrusted(g.workspace, '.'), reason);
  }
  fs.writeFileSync(path.join(f.workspace, '.npmrc'), 'registry=https://evil.example/');
  assert.match(untrusted(f.workspace, '.'), /npmrc/);
});

test('tarballs are integrity-checked, cached by lockfile hash and never partially kept', async t => {
  const f = fixture(t); let calls = 0;
  const dir = await fetchTarballs(f.workspace, '.', f.state, { fetchImpl: async (...a) => { calls++; return ok(...a); } });
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.tgz')).length, 1);
  await fetchTarballs(f.workspace, '.', f.state, { fetchImpl: async () => { calls++; return ok(); } });
  assert.equal(calls, 1, 'second run uses the cache');
  const dup = fixture(t, { 'node_modules/a/node_modules/demo': { resolved, integrity } }); calls = 0;
  const dupDir = await fetchTarballs(dup.workspace, '.', dup.state, { fetchImpl: async () => { calls++; return ok(); } });
  assert.equal(calls, 1, 'a tarball listed at two paths is fetched once'); assert.equal(fs.readdirSync(dupDir).filter(n => n.endsWith('.tgz')).length, 1);
  const bad = fixture(t);
  await assert.rejects(fetchTarballs(bad.workspace, '.', bad.state, { fetchImpl: async () => new Response('tampered') }), /Integrity/);
  assert.deepEqual(fs.readdirSync(path.join(bad.state, 'deps')), [], 'failed download leaves nothing behind');
});

test('a tarball listed under several lockfile paths is fetched once', async t => {
  const f = fixture(t, { 'node_modules/a/node_modules/demo': { resolved, integrity } }); let calls = 0;
  const dir = await fetchTarballs(f.workspace, '.', f.state, { fetchImpl: async () => { calls++; return ok(); } });
  assert.equal(calls, 1); assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.tgz')).length, 1);
});

test('install runs offline in the sandbox with a read-only tarball mount and reports failures without throwing', async t => {
  const f = fixture(t); const calls = [];
  const io = { linuxPolicy: a => ({ workspace: a.workspace }),
    sandboxExecute: async (policy, tool, args) => { calls.push({ policy, args }); } };
  const done = await installDependencies({ workspace: f.workspace, state: f.state, agent: {}, io, fetchImpl: ok });
  assert.deepEqual(done, { installed: ['.'], skipped: [], python: { installed: [], skipped: [] } });
  const [{ policy, args }] = calls;
  assert.notEqual(policy.network, true);
  assert.match(args.command, /npm ci --offline --ignore-scripts/);
  assert.equal(policy.readonly.length, 1);
  assert.ok(policy.readonly[0].startsWith(fs.realpathSync(f.state)));
  io.sandboxExecute = async () => { throw new Error('npm failed'); };
  const failed = await installDependencies({ workspace: f.workspace, state: f.state, agent: {}, io, fetchImpl: ok });
  assert.deepEqual(failed.installed, []); assert.match(failed.skipped[0].reason, /install failed/);
  assert.deepEqual(await installDependencies({ workspace: fs.mkdtempSync(path.join(f.state, 'empty-')), state: f.state, agent: {}, io }),
    { installed: [], skipped: [], python: { installed: [], skipped: [] } });
});

test('optional packages for other platforms are not downloaded', () => {
  const linux = { platform: 'linux', arch: 'x64' };
  assert.equal(needed({ optional: true, os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, linux), true);
  assert.equal(needed({ optional: true, os: ['darwin'], cpu: ['arm64'] }, linux), false);
  assert.equal(needed({ optional: true, os: ['linux'], cpu: ['arm64'] }, linux), false);
  assert.equal(needed({ optional: true, os: ['linux'], cpu: ['x64'], libc: ['musl'] }, linux), false);
  assert.equal(needed({ optional: true, os: ['!win32'] }, linux), true);
  assert.equal(needed({ optional: true, os: ['!linux'] }, linux), false);
  assert.equal(needed({ os: ['darwin'] }, linux), true, 'required packages are always fetched');
});

const whlName = 'demo-1.0.0-py3-none-any.whl';
const whlHash = createHash('sha256').update(bytes).digest('hex');
const wheelMeta = { urls: [
  { packagetype: 'sdist', filename: 'demo-1.0.0.tar.gz', url: 'https://files.pythonhosted.org/packages/demo/demo-1.0.0.tar.gz', digests: { sha256: '0'.repeat(64) } },
  { packagetype: 'bdist_wheel', filename: whlName, url: 'https://files.pythonhosted.org/packages/demo/' + whlName, digests: { sha256: whlHash } },
] };
function pyFixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-deps-py-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'ws'), state = path.join(root, 'state'); fs.mkdirSync(workspace); fs.mkdirSync(state);
  if (content !== undefined) fs.writeFileSync(path.join(workspace, 'python-requirements.txt'), content);
  return { workspace, state };
}

test('requirements discovery is bounded, sorted and free of duplicate marker names', t => {
  const f = pyFixture(t, 'demo==1.0.0 --hash=sha256:' + 'a'.repeat(64));
  fs.mkdirSync(path.join(f.workspace, '.devcontainer'));
  fs.writeFileSync(path.join(f.workspace, '.devcontainer', 'python-requirements.txt'), 'x==1 --hash=sha256:' + 'a'.repeat(64));
  fs.writeFileSync(path.join(f.workspace, 'requirements.txt'), 'y==2 --hash=sha256:' + 'b'.repeat(64));
  assert.deepEqual(requirementsFiles(f.workspace), [
    { dir: '.', file: 'python-requirements.txt' },
    { dir: '.', file: 'requirements.txt' },
    { dir: '.devcontainer', file: 'python-requirements.txt' },
  ]);
  assert.deepEqual(requirementsFiles(fs.mkdtempSync(path.join(f.state, 'none-'))), []);
});

test('requirements gate accepts only fully pinned, fully hashed files', t => {
  const f = pyFixture(t, 'yt-dlp==2026.08.19 --hash=sha256:' + 'a'.repeat(64) + ' --hash=sha256:' + 'b'.repeat(64));
  const { pins, reason } = parseRequirements(f.workspace, '.', 'python-requirements.txt');
  assert.equal(reason, undefined);
  assert.equal(pins[0].name, 'yt-dlp'); assert.equal(pins[0].hashes.size, 2);
  for (const [content, match] of [
    ['yt-dlp>=2026', /unpinned/],
    ['yt-dlp==2026.08.19', /bad hash/],
    ['yt-dlp==2026.08.19 --hash=sha256:nothex', /bad hash/],
    ['-r other.txt', /unpinned/],
    ['git+https://example.test/x', /unpinned/],
    ['--index-url https://evil.example', /unpinned/],
    ['   ', /no pinned/],
  ]) {
    const g = pyFixture(t, content);
    assert.match(parseRequirements(g.workspace, '.', 'python-requirements.txt').reason, match);
  }
  assert.match(parseRequirements(f.workspace, '../escape', 'python-requirements.txt').reason, /unsafe/);
});

test('wheels are hash-checked against every pin, cached by requirements hash and never partially kept', async t => {
  const f = pyFixture(t, `demo==1.0.0 --hash=sha256:${whlHash}`); let calls = 0;
  const fetchImpl = async url => { calls++; return new Response(String(url).endsWith('/json') ? JSON.stringify(wheelMeta) : bytes); };
  const dir = await fetchWheels(f.workspace, '.', 'python-requirements.txt', f.state, { fetchImpl });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.complete', whlName]);
  await fetchWheels(f.workspace, '.', 'python-requirements.txt', f.state, { fetchImpl });
  assert.equal(calls, 2, 'second run uses the cache');
  const tampered = pyFixture(t, `demo==1.0.0 --hash=sha256:${whlHash}`);
  await assert.rejects(fetchWheels(tampered.workspace, '.', 'python-requirements.txt', tampered.state,
    { fetchImpl: async url => new Response(String(url).endsWith('/json') ? JSON.stringify(wheelMeta) : 'forged') }), /Hash mismatch/);
  assert.deepEqual(fs.readdirSync(path.join(tampered.state, 'deps-py')), [], 'failed download leaves nothing behind');
  const none = pyFixture(t, 'demo==1.0.0 --hash=sha256:' + 'f'.repeat(64));
  await assert.rejects(fetchWheels(none.workspace, '.', 'python-requirements.txt', none.state, { fetchImpl }), /No pinned artifact/);
});

test('python install runs offline in the sandbox with a read-only wheel mount and never throws', async t => {
  const f = pyFixture(t, `demo==1.0.0 --hash=sha256:${whlHash}`); const calls = [];
  const io = { linuxPolicy: a => ({ workspace: a.workspace }),
    sandboxExecute: async (policy, tool, args) => { calls.push({ policy, args }); } };
  const fetchImpl = async url => new Response(String(url).endsWith('/json') ? JSON.stringify(wheelMeta) : bytes);
  const done = await installPython({ workspace: f.workspace, state: f.state, agent: {}, io, fetchImpl });
  assert.deepEqual(done, { installed: [{ dir: '.', requirements: 'python-requirements.txt' }], skipped: [] });
  const [{ policy, args }] = calls;
  assert.notEqual(policy.network, true);
  assert.match(args.command, /pip install --no-index --find-links .* --require-hashes -r python-requirements\.txt/);
  assert.match(args.command, /env -u PYTHONPATH/);
  assert.match(args.command, /\.git\/info\/exclude/);
  assert.equal(policy.readonly.length, 1);
  assert.ok(policy.readonly[0].startsWith(fs.realpathSync(f.state)));
  io.sandboxExecute = async () => { throw new Error('pip exploded with /abs/path detail'); };
  const failed = await installPython({ workspace: f.workspace, state: f.state, agent: {}, io, fetchImpl });
  assert.deepEqual(failed.installed, []); assert.match(failed.skipped[0].reason, /install failed/);
  // A broken requirements file is skipped without a download or sandbox call, and the run goes on.
  const bad = pyFixture(t, 'anything goes');
  const untouched = { linuxPolicy: a => ({ workspace: a.workspace }), sandboxExecute: async () => { throw new Error('must not run'); } };
  assert.match((await installPython({ workspace: bad.workspace, state: bad.state, agent: {}, io: untouched, fetchImpl })).skipped[0].reason, /unpinned/);
});
