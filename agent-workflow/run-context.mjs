// Producer-side observations only. Readers must never consult today's checkout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function captureRunContext(workspace) {
  const context = { context_recorded_at: new Date().toISOString() };
  try { context.workspace = fs.realpathSync(workspace); } catch { return context; }
  const git = args => {
    const r = spawnSync('git', ['--no-optional-locks', '-C', context.workspace, '-c', 'core.fsmonitor=false', ...args], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    });
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) return context;
  context.repo = path.basename(root);
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const commit = git(['rev-parse', '--verify', 'HEAD']);
  if (branch) context.checkout_branch = branch;
  if (/^[a-f0-9]{40,64}$/.test(commit ?? '')) {
    context.base_commit = commit;
    if (!branch) context.checkout_detached = true;
  }
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (dirty !== undefined) context.worktree_dirty = Boolean(dirty);
  return context;
}

// No log contents are read. Paths remain private; the Hub receives only this dated observation.
export function logObservation(location, kind) {
  let recorded = false;
  const hasLog = (p, depth = 0) => {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return false;
    if (stat.isFile()) return p.endsWith('.jsonl') && stat.size > 0;
    return stat.isDirectory() && depth < 3 && fs.readdirSync(p).slice(0, 100).some(name => hasLog(path.join(p, name), depth + 1));
  };
  try { recorded = Boolean(location) && hasLog(location); } catch { /* no recorded log */ }
  return { kind, status: recorded ? 'recorded' : 'unavailable', observed_at: new Date().toISOString(), ...(recorded ? { location } : {}) };
}
