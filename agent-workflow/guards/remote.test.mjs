import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const { remoteVerdict } = await import('./remote.ts');

test('remote runs read only inside their workspace, without a shell or secrets', (t) => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-guard-')));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'src'));
  fs.symlinkSync(os.homedir(), path.join(ws, 'home-link'));
  for (const [tool, input] of [['read', { path: 'src/a.js' }], ['ls', {}], ['grep', { pattern: '/auth/', path: 'src' }], ['find', { pattern: '**/*.md' }]]) {
    assert.equal(remoteVerdict(tool, input, ws), undefined, `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input] of [
    ['bash', { command: 'ls' }], ['edit', { path: 'src/a.js' }], ['write', { path: 'x' }],
    ['read', { path: '~/.pi/agent/auth.json' }], ['read', { path: '/etc/hosts' }], ['read', { path: '../outside' }],
    ['read', { path: 'home-link/.zshrc' }], ['read', { path: 'src/.env' }], ['find', { pattern: '/Users/**' }], ['grep', { pattern: 'x', path: '~' }],
  ]) assert.ok(remoteVerdict(tool, input, ws), `should block ${tool} ${JSON.stringify(input)}`);
});
