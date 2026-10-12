// `agent sync`: one-way mirrors between the Hub and this Mac, so no merge is ever needed.
//   pull   Hub decisions (accepted/rejected memory notes, ratings) -> ~/.agents git and local receipts. The Hub wins.
//   push   committed agent definitions, skills and evals (git HEAD of ~/.agents) -> the Hub. Git wins; refused if the
//          Hub holds a revision this checkout did not publish.
// Notes that are still pending are not mirrored: they wait in the Hub panel. Run `agent sync pull` after deciding notes
// there to keep the offline fallback and the git history current.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, STATE, scopeDir, formatFrontmatter, commitHome } from './agent.mjs';
import { hubCall, hubConfig, flushOutbox } from './hub.mjs';

const cursorFile = (state) => path.join(state, 'hub-sync.json');
const readCursor = (state) => { try { return JSON.parse(fs.readFileSync(cursorFile(state), 'utf8')).since ?? null; } catch { return null; } };
const ID = /^m-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const SCOPE = /^(shared|project:[a-z0-9][a-z0-9_-]*|agent:[a-z0-9][a-z0-9_-]*)$/;

export function mirrorNote(note, { root = ROOT } = {}) {
  if (!ID.test(note.id) || !SCOPE.test(note.scope) || typeof note.body !== 'string') return null;
  const rejectedFile = path.join(root, 'memory/rejected', `${note.id}.md`), acceptedFile = path.join(scopeDir(note.scope, root), `${note.id}.md`);
  const candidateFile = path.join(root, 'memory/candidates', `${note.id}.md`);
  const meta = { id: note.id, scope: note.scope, status: note.status, proposed_by: note.proposed_by, source_run: note.source_run, created: note.created,
    ...(note.status === 'accepted' ? { accepted: note.decided, supersedes: note.supersedes } : { rejected: note.decided, reason: note.reason }) };
  const [dest, other] = note.status === 'accepted' ? [acceptedFile, rejectedFile] : [rejectedFile, acceptedFile];
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const text = formatFrontmatter(meta, note.body);
  const changed = !fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== text;
  if (changed) fs.writeFileSync(dest, text);
  for (const stale of [other, candidateFile]) if (fs.existsSync(stale)) { fs.rmSync(stale); }
  return changed ? dest : null;
}

export function mirrorRating(rating, { state = STATE } = {}) {
  const file = path.join(state, 'runs', `${rating.run_id}.json`);
  if (!/^[rc]-[0-9TZ-]+-[a-f0-9]{6}$/.test(rating.run_id) || !fs.existsSync(file)) return false;
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (run.feedback?.rating === rating.rating && run.feedback?.at === rating.rated_at) return false;
  run.feedback = { rating: rating.rating, comment: rating.comment || undefined, at: rating.rated_at };
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
  return true;
}

export async function pull({ root = ROOT, state = STATE, config = hubConfig(), fetchImpl = fetch, commit = commitHome } = {}) {
  if (!config) throw new Error('This Mac is not linked to the Agents Hub (no ~/.config/agent-readonly/mac.json)');
  const sent = await flushOutbox({ state, config, fetchImpl });
  const since = readCursor(state);
  const { notes, ratings } = await hubCall(`decisions${since ? `?since=${encodeURIComponent(since)}` : ''}`, { config, fetchImpl, timeoutMs: 15000 });
  const files = notes.map((n) => mirrorNote(n, { root })).filter(Boolean);
  const rated = ratings.filter((r) => mirrorRating(r, { state })).length;
  if (files.length) commit(`Sync ${files.length} memory decision(s) from the Agents Hub`, root);
  const latest = [...notes.map((n) => n.decided), ...ratings.map((r) => r.rated_at)].filter(Boolean).sort().at(-1);
  if (latest) { fs.mkdirSync(state, { recursive: true, mode: 0o700 }); fs.writeFileSync(cursorFile(state), JSON.stringify({ since: latest }) + '\n', { mode: 0o600 }); }
  return { receipts_sent: sent, notes_mirrored: files.length, ratings_mirrored: rated };
}

const NAME = '[a-z0-9][a-z0-9_-]{0,63}';
const PUSHED = [new RegExp(`^agents/${NAME}\\.md$`), new RegExp(`^agent-skills/${NAME}/[A-Za-z0-9._-]{1,100}(/[A-Za-z0-9._-]{1,100}){0,3}\\.(md|py|json|txt)$`), new RegExp(`^evals/${NAME}/[A-Za-z0-9._-]{1,100}\\.md$`)];
const readState = (state) => { try { return JSON.parse(fs.readFileSync(cursorFile(state), 'utf8')); } catch { return {}; } };

/** The committed (reviewed) definitions at git HEAD: regular files only, no symlinks, nothing outside the allowed folders. */
export function committedKnowledge(root = ROOT) {
  const git = (...a) => { const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git ${a[0]} failed`); return r.stdout; };
  const revision = git('rev-parse', 'HEAD').trim(), files = {};
  for (const line of git('ls-tree', '-r', revision).split('\n').filter(Boolean)) {
    const [meta, name] = line.split('\t');
    if (meta.split(' ')[0] === '100644' && PUSHED.some((re) => re.test(name))) files[name] = git('show', `${revision}:${name}`);
  }
  return { revision, files };
}

export async function push({ root = ROOT, state = STATE, config = hubConfig(), fetchImpl = fetch } = {}) {
  if (!config) throw new Error('This Mac is not linked to the Agents Hub (no ~/.config/agent-readonly/mac.json)');
  const { revision, files } = committedKnowledge(root), saved = readState(state);
  const body = { revision, base: saved.pushed_revision ?? null, files };
  const result = await hubCall('knowledge', { method: 'POST', body, config, fetchImpl, timeoutMs: 30000 });
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(cursorFile(state), JSON.stringify({ ...saved, pushed_revision: revision }) + '\n', { mode: 0o600 });
  return { revision, files: result.files, removed: result.removed };
}

export async function cli(args) {
  if (args[0] === 'pull') {
    const r = await pull();
    console.log(`sent ${r.receipts_sent} waiting receipt(s); mirrored ${r.notes_mirrored} memory decision(s) and ${r.ratings_mirrored} rating(s) from the Hub`);
  } else if (args[0] === 'push') {
    const r = await push();
    console.log(`published ${r.files} file(s) at ${r.revision.slice(0, 12)} to the Hub (${r.removed} removed)`);
  } else throw new Error('usage: agent sync pull | agent sync push');
}
