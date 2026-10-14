#!/usr/bin/env node
// Fails if a private value appears in tracked files (default) or anywhere in history (--history).
// The values are regular expressions, one per line, in a file that is never committed:
// PRIVATE_VALUES (default ~/.config/agents-hub/private-values.txt). Usage: check.mjs [--history] [path...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const history = args.includes('--history');
const paths = args.filter(a => a !== '--history');
const list = process.env.PRIVATE_VALUES ?? path.join(os.homedir(), '.config/agents-hub/private-values.txt');
if (!fs.existsSync(list)) { console.error(`No private-values list at ${list}`); process.exit(2); }
const patterns = fs.readFileSync(list, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const git = (...a) => {
  const r = spawnSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) { console.error(r.stderr); process.exit(2); }
  return r.stdout;
};
const re = new RegExp(patterns.join('|'), 'i');
const hits = [];
if (history) {
  // Every blob and commit message reachable from any ref.
  let commit = '';
  for (const line of git('log', '--all', '-p', '--format=commit %H%n%B', '--', ...paths).split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19);
    const m = line.match(re);
    if (m) hits.push(`${commit}: ${m[0]}`);
  }
} else {
  for (const file of git('ls-files', '-z', '--', ...paths).split('\0').filter(Boolean)) {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(re);
      if (m) hits.push(`${file}:${i + 1}: ${m[0]}`);
    });
  }
}
// Print only the matched value, never the surrounding line.
for (const h of [...new Set(hits)]) console.log(h);
console.error(`${hits.length ? 'FAIL' : 'ok'}: ${hits.length} private value hit(s), ${patterns.length} patterns, ${history ? 'history' : 'tracked files'}`);
process.exit(hits.length ? 1 : 0);
