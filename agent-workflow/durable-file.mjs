import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function save(file, value) {
  const temporary = file + '.' + randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
    // Also persist newly created ancestor directory entries, up to the filesystem root.
    for (let dir = path.dirname(path.dirname(file)); ; dir = path.dirname(dir)) {
      syncDirectory(dir);
      if (dir === path.dirname(dir)) break;
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed, or disk unavailable */ }
  }
}
export function syncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function syncDirectory(dir) { syncFile(dir); }
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
