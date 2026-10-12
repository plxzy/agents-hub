import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mirrorNote, mirrorRating, pull } from './sync.mjs';
import { parseFrontmatter } from './agent.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
const note = (extra = {}) => ({ id: 'm-20261012T192242Z-c3e43a', scope: 'shared', status: 'accepted', body: 'A durable fact.', proposed_by: 'helper',
  source_run: 'r-20261012T192242Z-2d657b', created: '2026-10-12T19:22:42.000Z', decided: '2026-10-12T19:26:17.000Z', ...extra });

test('an accepted note lands in its scope folder and replaces any pending copy', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'memory/candidates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory/candidates/m-20261012T192242Z-c3e43a.md'), '---\nid: x\n---\nold');
  const dest = mirrorNote(note(), { root });
  assert.equal(dest, path.join(root, 'memory/shared/m-20261012T192242Z-c3e43a.md'));
  const { meta, body } = parseFrontmatter(fs.readFileSync(dest, 'utf8'));
  assert.equal(meta.status, 'accepted'); assert.equal(body.trim(), 'A durable fact.'); assert.equal(meta.accepted, '2026-10-12T19:26:17.000Z');
  assert.equal(fs.existsSync(path.join(root, 'memory/candidates/m-20261012T192242Z-c3e43a.md')), false);
  assert.equal(mirrorNote(note(), { root }), null); // unchanged: nothing to commit
});

test('a rejected note moves to rejected/ and an earlier accepted copy is removed (the Hub wins)', () => {
  const root = tmp();
  mirrorNote(note({ scope: 'project:vm' }), { root });
  assert.ok(fs.existsSync(path.join(root, 'memory/projects/vm/m-20261012T192242Z-c3e43a.md')));
  mirrorNote(note({ scope: 'project:vm', status: 'rejected', reason: 'wrong' }), { root });
  assert.equal(fs.existsSync(path.join(root, 'memory/projects/vm/m-20261012T192242Z-c3e43a.md')), false);
  assert.match(fs.readFileSync(path.join(root, 'memory/rejected/m-20261012T192242Z-c3e43a.md'), 'utf8'), /status: rejected[\s\S]*reason: wrong/);
});

test('hostile ids and scopes are ignored', () => {
  const root = tmp();
  assert.equal(mirrorNote(note({ id: '../../x' }), { root }), null);
  assert.equal(mirrorNote(note({ scope: '../etc' }), { root }), null);
});

test('ratings update the local receipt only', () => {
  const state = tmp(); fs.mkdirSync(path.join(state, 'runs'));
  fs.writeFileSync(path.join(state, 'runs/r-20261012T120000Z-abcdef.json'), JSON.stringify({ run_id: 'r-20261012T120000Z-abcdef' }));
  assert.equal(mirrorRating({ run_id: 'r-20261012T120000Z-abcdef', rating: 'good', comment: 'ok', rated_at: '2026-10-12T20:00:00.000Z' }, { state }), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'runs/r-20261012T120000Z-abcdef.json'), 'utf8')).feedback.rating, 'good');
  assert.equal(mirrorRating({ run_id: 'r-20261012T120000Z-aaaaaa', rating: 'good', rated_at: 'x' }, { state }), false); // not a local run
});

test('pull sends waiting receipts, mirrors decisions and moves its cursor', async () => {
  const root = tmp(), state = tmp(), urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ notes: [note()], ratings: [] }) }; };
  const commits = [];
  const r = await pull({ root, state, config: { endpoint: 'https://hub.example', token: 't'.repeat(32) }, fetchImpl, commit: (m) => commits.push(m) });
  assert.deepEqual(r, { receipts_sent: 0, notes_mirrored: 1, ratings_mirrored: 0 });
  assert.equal(commits.length, 1); assert.match(urls[0], /decisions$/);
  await pull({ root, state, config: { endpoint: 'https://hub.example', token: 't'.repeat(32) }, fetchImpl, commit: () => {} });
  assert.match(urls[1], /decisions\?since=2026-10-12T19%3A26%3A17.000Z$/);
});

test('push publishes only committed, allowed regular files and remembers the revision it published', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = tmp(), state = tmp(), git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 'a');
  for (const [f, c] of Object.entries({ 'agents/helper.md': 'def', 'agent-skills/demo/SKILL.md': 's', 'evals/helper/e.md': 'q', 'memory/shared/m.md': 'note', 'agents/UPPER.md': 'x' })) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c);
  }
  fs.symlinkSync('/etc/passwd', path.join(root, 'agents/link.md'));
  git('add', '-A'); git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(root, 'agents/helper.md'), 'UNCOMMITTED EDIT');
  const { committedKnowledge, push } = await import('./sync.mjs');
  assert.deepEqual(Object.keys(committedKnowledge(root).files).sort(), ['agent-skills/demo/SKILL.md', 'agents/helper.md', 'evals/helper/e.md']);
  assert.equal(committedKnowledge(root).files['agents/helper.md'], 'def'); // the reviewed commit, not the working tree
  let sent;
  const ok = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ ok: true, files: 3, removed: 0 }) }; };
  const config = { endpoint: 'https://hub.example', token: 't'.repeat(32) };
  const r = await push({ root, state, config, fetchImpl: ok });
  assert.equal(r.files, 3); assert.equal(sent.base, null); assert.equal(sent.revision, git('rev-parse', 'HEAD').stdout.trim());
  await push({ root, state, config, fetchImpl: ok });
  assert.equal(sent.base, r.revision); // the next push builds on what this checkout published
  await assert.rejects(push({ root, state, config, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'The Hub holds abc, which this push does not build on.' }) }) }), /The Hub holds abc/);
});
