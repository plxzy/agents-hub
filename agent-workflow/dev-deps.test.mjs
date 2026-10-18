import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lockfileDirs, untrusted, fetchTarballs, installDependencies, needed } from './dev-deps.mjs';

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
  assert.deepEqual(done, { installed: ['.'], skipped: [] });
  const [{ policy, args }] = calls;
  assert.notEqual(policy.network, true);
  assert.match(args.command, /npm ci --offline --ignore-scripts/);
  assert.equal(policy.readonly.length, 1);
  assert.ok(policy.readonly[0].startsWith(fs.realpathSync(f.state)));
  io.sandboxExecute = async () => { throw new Error('npm failed'); };
  const failed = await installDependencies({ workspace: f.workspace, state: f.state, agent: {}, io, fetchImpl: ok });
  assert.deepEqual(failed.installed, []); assert.match(failed.skipped[0].reason, /install failed/);
  assert.deepEqual(await installDependencies({ workspace: fs.mkdtempSync(path.join(f.state, 'empty-')), state: f.state, agent: {}, io }), { installed: [], skipped: [] });
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
