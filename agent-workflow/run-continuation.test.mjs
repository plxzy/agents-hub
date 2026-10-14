import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DevelopmentSessions } from './dev-sessions.mjs';
import { save, read } from './durable-file.mjs';
import { reviewSource } from './run-continuation.mjs';

function fixture(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = path.join(state, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'file'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'file'), 'saved patch'); git(repo, 'commit', '-am', 'patch');
  const commit = git(repo, 'rev-parse', 'HEAD'), id = 'r-20261014T000000Z-abcdef';
  git(repo, 'branch', 'review/runs/' + id); git(repo, 'reset', '--hard', base);
  for (const dir of ['agent-runs', 'agent-requests', 'recovery-v1', 'knowledge', 'run-work/' + id]) fs.mkdirSync(path.join(state, dir), { recursive: true });
  save(path.join(state, 'knowledge', 'RELEASE.json'), { source_revision: 'fixture' });
  const agent = { name: 'demo', version: 'v1', model: 'openai/gpt-6-luna', thinking: 'low', tools: ['read', 'write'], skills: 'none', memory: [], instructions: 'Test', workspace: '/repo' };
  const original = { run_id: id, root: id, agent: 'demo', repo: 'demo', status: 'completed', commit, base_commit: base,
    review_ref: 'refs/heads/review/runs/' + id, accounts_used: ['openai'] };
  save(path.join(state, 'agent-runs', id + '.json'), original);
  fs.writeFileSync(path.join(state, 'run-work', id, 'head'), id);
  const workspace = path.join(state, 'run-work', id, 'workspace');
  let starts = 0; const finals = new Map();
  const host = Object.assign(Object.create(DevelopmentSessions.prototype), {
    state, revision: 'fixture', repos: { demo: path.join(repo, '.git') }, knowledge: path.join(state, 'knowledge'),
    limits: { slots: ['openai'], writeRuns: 2, runs: 2, writeMs: 10000 }, runs: new Map(),
    room() {}, runnable: () => [agent], repoFor: () => 'demo', prune() {}, poolSlots: async () => ['openai'],
    report: async id => { const r = host.runGet(id); if (r.status !== 'running') finals.set(id, r); },
    harvest: async () => ({ commit: git(workspace, 'rev-parse', 'HEAD'), changed_files: [] }),
    runIO: {
      execFileSync, linuxPolicy: a => ({ workspace: a.workspace }),
      sandboxExecute: async (policy, _tool, args) => { execFileSync('/bin/sh', ['-c', args.command], { cwd: policy.workspace }); return {}; },
      spawn() {
        starts++; assert.equal(fs.readFileSync(path.join(workspace, 'file'), 'utf8'), 'saved patch');
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
        child.stdin.on('finish', () => queueMicrotask(() => {
          const runtime = { engine: 'pi-sdk', provider: 'openai', model: 'gpt-6-luna', thinking: 'low', pi_version: '1.1.0' };
          child.emit('message', { type: 'runtime', runtime });
          child.stdout.write(JSON.stringify({ runtime, output: 'Reviewed saved patch', slots_used: ['openai'] })); child.emit('close', 0);
        })); return child;
      },
    },
  });
  async function finish(id) {
    for (let n = 0; n < 100 && !finals.has(id); n++) await new Promise(r => setTimeout(r, 10));
    assert.ok(finals.has(id), 'run must finish'); return finals.get(id);
  }
  return { host, original, finish, git, repo, workspace, starts: () => starts };
}

test('no-edit reviews preserve the exact source and can be continued again through production callbacks', async t => {
  const f = fixture(t); let prior = f.original;
  f.host.prepareBase = async () => { assert.fail('continuation must never fetch a fresh base'); };
  for (let n = 0; n < 2; n++) {
    const started = await f.host.runStart({ request_id: 'continuation-' + n, agent: 'demo', task: 'Review the saved patch', continue_from: prior.run_id });
    const final = await f.finish(started.run_id);
    assert.equal(final.status, 'completed'); assert.equal(final.commit, f.original.commit);
    assert.equal(final.review_ref, undefined); assert.deepEqual(final.changed_files, []);
    assert.deepEqual(final.source_review, reviewSource(f.original));
    assert.equal(fs.readFileSync(path.join(f.host.state, 'run-work', f.original.run_id, 'head'), 'utf8'), final.run_id);
    prior = final;
  }
  assert.equal(f.starts(), 2);
  await assert.rejects(f.host.runStart({ request_id: 'stale-parent', agent: 'demo', task: 'Review', continue_from: f.original.run_id }), /latest run/);
});

test('moved and missing review refs refuse before starting Pi or replacing retained files', async t => {
  for (const missing of [false, true]) {
    const f = fixture(t);
    fs.mkdirSync(f.workspace); fs.writeFileSync(path.join(f.workspace, 'preserve'), 'retained');
    if (missing) f.git(f.repo, 'branch', '-D', 'review/runs/' + f.original.run_id);
    else f.git(f.repo, 'branch', '-f', 'review/runs/' + f.original.run_id, f.original.base_commit);
    const start = await f.host.runStart({ request_id: 'bad-ref-test', agent: 'demo', task: 'Review', continue_from: f.original.run_id });
    const r = await f.finish(start.run_id);
    assert.notEqual(r.status, 'completed'); assert.match(r.error, missing ? /ref unavailable/ : /commit mismatch/);
    assert.equal(f.starts(), 0); assert.equal(fs.readFileSync(path.join(f.workspace, 'preserve'), 'utf8'), 'retained');
  }
});

test('expired, foreign and unfinished conversations cannot fall back to main', async t => {
  const f = fixture(t), file = path.join(f.host.state, 'agent-runs', f.original.run_id + '.json');
  const args = { request_id: 'refusal-test', agent: 'demo', task: 'Review', continue_from: f.original.run_id };
  save(file, { ...f.original, repo: 'other' });
  await assert.rejects(f.host.runStart(args), /same|repository/);
  save(file, f.original);
  const failed = { ...f.original, run_id: 'r-20261014T000001Z-abcdef', status: 'failed' };
  save(path.join(f.host.state, 'agent-runs', failed.run_id + '.json'), failed);
  await assert.rejects(f.host.runStart(args), /Retained unfinished/);
  fs.unlinkSync(path.join(f.host.state, 'agent-runs', failed.run_id + '.json'));
  fs.unlinkSync(path.join(f.host.state, 'run-work', f.original.run_id, 'head'));
  await assert.rejects(f.host.runStart(args), /expired.*artifact/);
  assert.equal(f.starts(), 0);
});

test('independent runs fail before Pi when fresh GitHub base is unavailable', async t => {
  const f = fixture(t); let requested = false;
  f.host.prepareBase = async (repo, runId) => {
    requested = true; assert.equal(repo, 'demo'); assert.match(runId, /^r-/);
    throw Error('Fresh GitHub base unavailable; check review publisher');
  };
  const started = await f.host.runStart({ request_id: 'fresh-base-required', agent: 'demo', task: 'Inspect main' });
  const final = await f.finish(started.run_id);
  assert.equal(requested, true); assert.notEqual(final.status, 'completed');
  assert.match(final.error, /Fresh GitHub base unavailable/); assert.equal(f.starts(), 0);
});
