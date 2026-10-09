import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serveLink } from './link.mjs';
import { acquireLinkLock } from './link-lock.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.plan-1b-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { lock: path.join(dir, 'link.lock'), configFile: path.join(dir, 'link.json') };
}
test('an ambiguous PID probe must preserve the existing owner lock', async (t) => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  fs.writeFileSync(f.lock, '12345');
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
  await assert.rejects(serveLink({ configFile: f.configFile, signal: controller.signal }), /owner|running/i);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), '12345');
});

for (const code of ['EPERM', 'EACCES', 'EINVAL', undefined]) test(`PID probe ${code ?? 'unknown'} fails closed`, t => {
  const f = fixture(t); fs.writeFileSync(f.lock, '12345');
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('fixture probe'), { code }); });
  assert.throws(() => acquireLinkLock(f.lock), /unknown/);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), '12345'); assert.equal(fs.existsSync(f.lock + '.acquiring'), false);
});
for (const text of ['', 'garbage', '0', '-1', '12.5', '9007199254740993']) test(`malformed PID ${JSON.stringify(text)} is not evidence of a dead owner`, t => {
  const f = fixture(t); fs.writeFileSync(f.lock, text);
  t.mock.method(process, 'kill', () => assert.fail('must not probe malformed PID'));
  assert.throws(() => acquireLinkLock(f.lock), /ambiguous/); assert.equal(fs.readFileSync(f.lock, 'utf8'), text);
});
test('a live owner is refused; ESRCH permits reclamation and cleanup is idempotent', t => {
  const f = fixture(t); fs.writeFileSync(f.lock, String(process.pid));
  assert.throws(() => acquireLinkLock(f.lock), /already running/);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const release = acquireLinkLock(f.lock);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid));
  release(); release(); assert.equal(fs.existsSync(f.lock), false);
});
test('an acquisition gate fences concurrent stale reclaimers and is never automatically removed', t => {
  const f = fixture(t); fs.writeFileSync(f.lock, '12345'); fs.writeFileSync(f.lock + '.acquiring', 'other-owner');
  assert.throws(() => acquireLinkLock(f.lock), /acquisition/);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), '12345'); assert.equal(fs.readFileSync(f.lock + '.acquiring', 'utf8'), 'other-owner');
});
test('release must not delete a replaced lock', t => {
  const f = fixture(t), release = acquireLinkLock(f.lock);
  fs.renameSync(f.lock, f.lock + '.old'); fs.writeFileSync(f.lock, '12345');
  release(); assert.equal(fs.readFileSync(f.lock, 'utf8'), '12345');
});
