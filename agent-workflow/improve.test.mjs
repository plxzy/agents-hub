import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getAgent } from './agent.mjs';
import { acceptProposal, addEval, checkCase, parseProposals, pending, recordFeedback, rejectProposal, replaceInstructions, runEvals } from './improve.mjs';

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents/demo.md'), '---\nname: demo\ntools: read\nmemory:\n  scope: project\n---\nOld instructions.\n');
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'add', '-A']);
  spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return { root, state: path.join(root, '.state') };
}

test('checkCase applies include, exclude and tool budget', () => {
  const c = { include: ['codex', 'fall ?back'], exclude: ['guarantee'], maxTools: 1 };
  assert.deepEqual(checkCase(c, { output: 'Codex can still fall back.', toolCalls: 1 }), { pass: true, problems: [] });
  const bad = checkCase(c, { output: 'It is a guarantee.', toolCalls: 3 });
  assert.equal(bad.pass, false);
  assert.equal(bad.problems.length, 4);
});

test('parseProposals reads eval and instruction blocks with headers', () => {
  const p = parseProposals('x\n```eval\nwhy: w\nmust_include: a, b\nmax_tools: 2\nWhat is a?\n```\n```instructions\nwhy: too long\nBe brief.\nCite files.\n```');
  assert.deepEqual(p.evals, [{ why: 'w', include: ['a', 'b'], exclude: [], run: [], notRun: [], maxTools: 2, question: 'What is a?' }]);
  assert.deepEqual(p.instructions, [{ why: 'too long', body: 'Be brief.\nCite files.' }]);
});

test('replaceInstructions keeps frontmatter byte for byte', () => {
  const text = '---\nname: x\nmemory:\n  scope: project\n---\nold\n';
  assert.equal(replaceInstructions(text, 'new'), '---\nname: x\nmemory:\n  scope: project\n---\nnew\n');
});

test('accepting an instruction proposal rewrites the agent and commits a new version', () => {
  const { root } = home();
  const before = getAgent('demo', root).version;
  fs.mkdirSync(path.join(root, 'proposals'));
  fs.writeFileSync(path.join(root, 'proposals/i-1.md'), `---\nid: i-1\nkind: instructions\nagent: demo\nbase_version: ${before}\nwhy: test\n---\nNew instructions.\n`);
  assert.equal(pending(root).length, 1);
  acceptProposal('i-1', { root });
  const agent = getAgent('demo', root);
  assert.equal(agent.instructions, 'New instructions.');
  assert.notEqual(agent.version, before);
  assert.match(fs.readFileSync(agent.file, 'utf8'), /memory:\n {2}scope: project/);
  const log = spawnSync('git', ['-C', root, 'log', '--oneline'], { encoding: 'utf8' }).stdout;
  assert.match(log, /Accept instructions proposal i-1 for demo: test/);
});

test('stale instruction proposals are refused', () => {
  const { root } = home();
  fs.mkdirSync(path.join(root, 'proposals'));
  fs.writeFileSync(path.join(root, 'proposals/i-2.md'), '---\nid: i-2\nkind: instructions\nagent: demo\nbase_version: 000000000000\n---\nX\n');
  assert.throws(() => acceptProposal('i-2', { root }), /changed since this proposal/);
  rejectProposal('i-2', 'stale', { root });
  assert.equal(pending(root).length, 0);
});

test('runEvals scores cases and keeps history for comparison', async () => {
  const { root, state } = home();
  addEval('demo', 'Q1', { include: ['yes'], root });
  addEval('demo', 'Q2', { include: ['no'], maxTools: 0, root });
  const fake = async (name, task) => ({ run_id: `r-${task}`, status: 'completed', output: task === 'Q1' ? 'yes' : 'no', tool_calls: task === 'Q2' ? ['ls'] : [], usage: { totalTokens: 10, cost: 0.001 } });
  const first = await runEvals('demo', { root, state, run: fake });
  assert.equal(first.report.passed, 1);
  assert.equal(first.previous, null);
  const second = await runEvals('demo', { root, state, run: fake });
  assert.equal(second.previous.passed, 1);
});

test('feedback is stored on the run receipt', () => {
  const { state } = home();
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(state, 'runs/r-1.json'), JSON.stringify({ run_id: 'r-1', agent: 'demo', kind: 'task' }));
  recordFeedback('last', 'bad', 'too long', { state });
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'runs/r-1.json'), 'utf8')).feedback.rating, 'bad');
});

test('checkCase can require or forbid commands', () => {
  const c = { include: [], exclude: [], run: ['traffic\\.py'], notRun: ['\\bsudo\\b'], maxTools: null };
  assert.equal(checkCase(c, { output: '', toolCalls: 1, commands: ['traffic.py 5'] }).pass, true);
  assert.deepEqual(checkCase(c, { output: '', toolCalls: 1, commands: ['sudo lsof'] }).problems, ['did not run /traffic\\.py/', 'ran /\\bsudo\\b/']);
});
