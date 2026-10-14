#!/usr/bin/env node
// Operator-only recovery of historical receipts. Never runs a model or changes project refs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { save, read } from '../../agent-workflow/durable-file.mjs';
import { privateResult } from '../../agent-workflow/run-recovery.mjs';

const [configFile, ...args] = process.argv.slice(2), apply = args.includes('--apply');
if (!configFile || args.filter(x => x !== '--apply').length === 0) throw Error('Usage: reconcile-interrupted.mjs PRIVATE_CONFIG RUN_ID... [--apply]');
const config = read(configFile), state = config.state;
const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
function files(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []) : []; }
for (const id of args.filter(x => x !== '--apply')) {
  if (!/^r-\d{8}T\d{6}Z-[a-f0-9]{6}$/.test(id)) throw Error('Invalid run ID');
  const file = path.join(state, 'agent-runs', id + '.json'), receipt = read(file);
  if (receipt.status !== 'interrupted') throw Error('Only interrupted receipts can be reconciled');
  const base = path.join(state, 'run-work', receipt.root ?? id), sessionFiles = files(path.join(base, 'pi-sessions'));
  const candidates = [];
  for (const session of sessionFiles) {
    if (fs.statSync(session).size > 32 * 1024 ** 2) continue;
    for (const line of fs.readFileSync(session, 'utf8').split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const m = e.message, time = Date.parse(e.timestamp) || m?.timestamp;
      if (e.type !== 'message' || m?.role !== 'assistant' || time < Date.parse(receipt.started) || time > Date.parse(receipt.ended) || !Number.isFinite(time)) continue;
      const text = (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (text) candidates.push({ time, text, stop: m.stopReason });
    }
  }
  candidates.sort((a, b) => b.time - a.time);
  const latest = candidates[0], patch = {};
  if (!receipt.output && latest) {
    const safe = privateResult({ content: [{ type: 'text', text: latest.text.slice(0, 40000) }] }).content[0].text;
    patch.output = `Recovered from the retained Pi session at ${new Date(latest.time).toISOString()} (recorded stop reason: ${latest.stop ?? 'unknown'}). The original run remains interrupted; this transcript does not independently verify its claims.\n\n${safe}`;
    patch.output_partial = true;
  }
  const repository = config.repositories?.[receipt.repo] ?? (receipt.repo === 'dev-workflow' ? config.repository : undefined);
  const ref = 'refs/heads/review/runs/' + id;
  if (repository && fs.existsSync(path.join(base, 'head')) && fs.readFileSync(path.join(base, 'head'), 'utf8').trim() === id) {
    const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '--git-dir=' + repository, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const commit = git('rev-parse', '--verify', ref + '^{commit}');
      const ancestor = receipt.base_commit ?? receipt.commit;
      if (!/^[a-f0-9]{40,64}$/.test(ancestor)) throw Error('Missing original base');
      git('merge-base', '--is-ancestor', ancestor, commit);
      patch.review_ref = ref; patch.commit = commit; patch.base_commit = ancestor;
      patch.changed_files = git('diff', '--name-only', '-z', ancestor, commit).split('\0').filter(n => n && !/[\r\n]/.test(n)).slice(0, 200);
    } catch { /* Missing or unverified refs are never presented as recovered work. */ }
  }
  const found = Boolean(latest || patch.review_ref);
  if (apply && found) {
    const backup = path.join(state, 'receipt-recovery-backups', id);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const original = path.join(backup, 'original.json');
    if (!fs.existsSync(original)) fs.copyFileSync(file, original, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(original, 0o600);
    save(file, { ...receipt, ...patch, recovery: { state: 'unavailable', retained: true,
      revision: (receipt.recovery?.revision ?? 0) + 1, reason: 'Historical artifacts recovered; no safe resumable checkpoint' }, reported_at: undefined });
  }
  console.log(JSON.stringify({ run_id: id, sessions: sessionFiles.length, recovered_output: Boolean(patch.output), verified_review_ref: patch.review_ref ?? null, commit: patch.commit ?? null, applied: apply && found }));
}
