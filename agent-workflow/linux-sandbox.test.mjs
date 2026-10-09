import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { linuxPolicy, sandboxArgs, sandboxExecute } from './linux-sandbox.mjs';

test('sandbox mount policy rejects writable tool/runtime roots', () => {
  const p = { workspace: '/home/project', release: '/home/release', runtime: '/home/runtime', sdk: '/home/runtime/index.js', protected: [] };
  assert.throws(() => sandboxArgs({ ...p, release: '/home/project/release' }), /Writable/);
  const args = sandboxArgs(p);
  assert.ok(args.includes('--unshare-all'));
  assert.ok(args.includes('--clearenv'));
  assert.ok(!args.includes('/home'));
  assert.ok(!args.includes('--share-net'));
});

test('real Linux tools isolate secrets, protect files, support loopback and kill detached descendants',
  { skip: process.platform !== 'linux' || process.env.AGENT_TEST_LINUX !== '1', timeout: 45000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.local/state/linux-acceptance-'));
  const workspace = path.join(base, 'workspace'); fs.mkdirSync(workspace);
  const secret = path.join(base, 'synthetic-secret'); fs.writeFileSync(secret, 'SYNTHETIC_MARKER');
  fs.symlinkSync(secret, path.join(workspace, 'escape'));
  const protectedFile = path.join(workspace, 'protected'); fs.writeFileSync(protectedFile, 'original');
  assert.throws(() => linuxPolicy({ workspace, writePaths: [] }, path.join(base, 'state')), /explicitly writable/);
  assert.throws(() => linuxPolicy({ workspace, writePaths: [protectedFile] }, path.join(base, 'state')), /explicitly writable/);
  const p = linuxPolicy({ workspace, writePaths: [workspace], protectPaths: [protectedFile] }, path.join(base, 'state'));
  const write = await sandboxExecute(p, 'write', { path: 'file.txt', content: 'hello' });
  assert.ok(write.content);
  assert.match(JSON.stringify(await sandboxExecute(p, 'read', { path: 'file.txt' })), /hello/);
  await assert.rejects(sandboxExecute(p, 'read', { path: secret }));
  await assert.rejects(sandboxExecute(p, 'read', { path: 'escape' }));
  await assert.rejects(sandboxExecute(p, 'write', { path: 'protected', content: 'changed' }));
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'original');
  const loopback = `node -e 'const n=require("net");const s=n.createServer(c=>c.end("LOOPBACK_OK"));s.listen(0,"127.0.0.1",()=>{const c=n.connect(s.address().port,"127.0.0.1");c.on("data",d=>console.log(d.toString()));c.on("end",()=>s.close());})'`;
  assert.match(JSON.stringify(await sandboxExecute(p, 'bash', { command: loopback })), /LOOPBACK_OK/);
  const controller = new AbortController();
  const childScript = 'const fs=require("fs");setInterval(()=>fs.appendFileSync("ticks","x"),40)';
  const command = `setsid node -e '${childScript}' & wait`;
  const pending = sandboxExecute(p, 'bash', { command }, { signal: controller.signal });
  const ticks = path.join(workspace, 'ticks');
  for (let n = 0; n < 100 && !fs.existsSync(ticks); n++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(ticks), 'detached descendant started');
  controller.abort();
  await assert.rejects(pending, /aborted/);
  const size = fs.statSync(ticks).size;
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.statSync(ticks).size, size, 'detached descendant stopped');
});
