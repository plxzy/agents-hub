import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getAgent } from './agent.mjs';
import { loadEvals, regexFlags, acceptProposal, addEval, checkCase, parseProposals, pending, recordFeedback, rejectProposal, replaceInstructions, runEvals } from './improve.mjs';

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents/demo.md'), '---\nname: demo\ntools: read\nmemory:\n  scope: project\n---\nOld instructions.\n');
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'add', '-A']);
  spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return { root, state: path.join(root, '.state') };
}

test('regex flags repeat and preserve commas, with single-value legacy compatibility', (t) => {
  const { root } = home();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const flag of ['--include', '--exclude', '--run', '--not-run']) {
    const args = ['demo', flag, 'hello, world', flag, 'a{1,3}', 'question'];
    assert.deepEqual(regexFlags(args, flag), ['hello, world', 'a{1,3}']);
    assert.deepEqual(args, ['demo', 'question']);
    assert.deepEqual(regexFlags([flag, 'a, b'], flag), ['a', 'b']);
    assert.deepEqual(regexFlags([flag, 'a{1,3}'], flag), ['a{1,3}']);
    assert.deepEqual(regexFlags([], flag), []);
    assert.throws(() => regexFlags([flag], flag), /requires a regex/);
  }
  const patterns = ['hello, world', 'a{1,3}', '\\bword\\b', '[a,b]'];
  addEval('demo', 'Q', { root, include: patterns, exclude: patterns, run: patterns, notRun: patterns });
  const [c] = loadEvals('demo', root);
  for (const key of ['include', 'exclude', 'run', 'notRun']) assert.deepEqual(c[key], patterns);
  fs.writeFileSync(path.join(root, 'evals/demo/legacy.md'), '---\nmust_include: a, b\n---\nOld question\n');
  assert.deepEqual(loadEvals('demo', root).find((c) => c.id === 'legacy').include, ['a', 'b']);
});

test('sandboxed evals abort with an actionable message instead of a score', async (t) => {
  const { root, state } = home();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = process.env.AGENT_SANDBOXED;
  t.after(() => { if (original === undefined) delete process.env.AGENT_SANDBOXED; else process.env.AGENT_SANDBOXED = original; });
  process.env.AGENT_SANDBOXED = '1';
  fs.writeFileSync(path.join(root, 'agents/demo.md'), `---\nname: demo\nwrite_paths: ${root}\n---\nBe brief.\n`);
  addEval('demo', 'Q', { root });
  await assert.rejects(runEvals('demo', { root, state, run: () => assert.fail('must not run') }), /ask the user to run: agent eval demo/);
  assert.equal(fs.existsSync(path.join(state, 'evals')), false);
});

test('eval cwd is saved only for here agents and must be absolute', (t) => {
  const { root } = home();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addEval('demo', 'Fixed', { root, cwd: 'ignored-relative-path' });
  assert.equal(loadEvals('demo', root)[0].cwd, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'evals/demo', fs.readdirSync(path.join(root, 'evals/demo'))[0]), 'utf8'), /cwd:/);
  fs.writeFileSync(path.join(root, 'agents/demo.md'), '---\nname: demo\nworkspace: here\n---\nBe brief.\n');
  addEval('demo', 'Default', { root });
  addEval('demo', 'Override', { root, cwd: os.homedir() });
  const cases = loadEvals('demo', root);
  assert.equal(cases.find((c) => c.question === 'Default').cwd, process.cwd());
  assert.equal(cases.find((c) => c.question === 'Override').cwd, os.homedir());
  assert.throws(() => addEval('demo', 'Bad', { root, cwd: 'relative' }), /absolute path/);
});

test('here evals use saved cwd from home and legacy cases use the launch folder', async (t) => {
  const { root, state } = home();
  const launch = process.cwd();
  const sandboxed = process.env.AGENT_SANDBOXED;
  t.after(() => {
    process.chdir(launch);
    if (sandboxed === undefined) delete process.env.AGENT_SANDBOXED;
    else process.env.AGENT_SANDBOXED = sandboxed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  delete process.env.AGENT_SANDBOXED;
  fs.writeFileSync(path.join(root, 'agents/demo.md'), '---\nname: demo\nworkspace: here\n---\nBe brief.\n');
  addEval('demo', 'Saved', { root, cwd: launch });
  const seen = [];
  const run = async (name, question, options) => {
    seen.push([question, options.cwd]);
    return { run_id: 'r-fake', status: 'completed', output: '', tool_calls: [], usage: { totalTokens: 0, cost: 0 } };
  };
  process.chdir(os.homedir());
  await runEvals('demo', { root, state, run });
  assert.deepEqual(seen, [['Saved', launch]]);
  fs.writeFileSync(path.join(root, 'evals/demo/legacy.md'), '---\nid: legacy\n---\nLegacy\n');
  await assert.rejects(runEvals('demo', { root, state, run }), /strictly inside/);
  process.chdir(launch);
  await runEvals('demo', { root, state, run });
  assert.deepEqual(seen.slice(1).sort(), [['Legacy', launch], ['Saved', launch]]);
  fs.writeFileSync(path.join(root, 'agents/demo.md'), `---\nname: demo\nworkspace: ${launch}\n---\nBe brief.\n`);
  await runEvals('demo', { root, state, run });
  assert.ok(seen.slice(3).every(([, cwd]) => cwd === undefined));
});

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
