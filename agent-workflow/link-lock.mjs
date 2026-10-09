import fs from 'node:fs';
import path from 'node:path';

// Serialize stale-lock reclamation as well as creation: two reclaimers must not unlink a new owner.
// An abandoned acquisition gate fails closed; it needs operator inspection, never automatic deletion.
export function acquireLinkLock(lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const gate = lock + '.acquiring';
  let fd;
  try { fd = fs.openSync(gate, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error('Relay ownership acquisition is busy or interrupted; inspect the acquisition lock before restarting.');
    throw e;
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    if (fs.existsSync(lock)) {
      const text = fs.readFileSync(lock, 'utf8'), pid = Number(text);
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(pid) || pid > 2147483647) {
        throw new Error('Relay owner PID is ambiguous; inspect the existing lock before restarting.');
      }
      try { process.kill(pid, 0); }
      catch (e) {
        if (e.code !== 'ESRCH') throw new Error('Relay owner liveness is unknown; preserve the existing lock and inspect it before restarting.');
        fs.unlinkSync(lock); // ESRCH alone establishes that the recorded owner is gone.
      }
      if (fs.existsSync(lock)) throw new Error('A relay process is already running');
    }
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    const owner = fs.statSync(lock);
    return () => {
      if (!fs.existsSync(lock)) return;
      const current = fs.statSync(lock);
      if (current.dev === owner.dev && current.ino === owner.ino && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
    };
  } finally { fs.closeSync(fd); fs.unlinkSync(gate); }
}
