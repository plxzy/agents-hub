import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { listRuns, runAgent } from './agent.mjs';
import { createServer, toolList } from './mcp.mjs';
import { DASHBOARD_URI, OPS, callOp, dashboardData } from './ops.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ops-'));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents/demo.md'), `---\nname: demo\ndescription: test agent\ntools: read\nworkspace: ${root}\n---\nBe brief.\n`);
  fs.mkdirSync(path.join(root, 'memory/candidates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory/candidates/m-1.md'), '---\nid: m-20261009T000000Z-abcdef\nscope: agent:demo\nstatus: candidate\nproposed_by: demo\n---\nA fact.\n');
  return { root, state: path.join(root, '.state') };
}

test('every operation has a unique name, a known access level and a JSON schema', () => {
  assert.equal(new Set(OPS.map((o) => o.name)).size, OPS.length);
  for (const op of OPS) {
    assert.ok(['read', 'run', 'decide'].includes(op.access), op.name);
    assert.equal(op.input.type, 'object', op.name);
  }
  assert.deepEqual(OPS.filter((o) => o.access === 'decide').map((o) => o.name).sort(), ['rate_run', 'review_decide']);
});

test('callOp refuses operations outside the allowed access levels', async () => {
  const ctx = fixture();
  await assert.rejects(callOp('review_decide', { id: 'x', decision: 'accept' }, { ctx, allow: ['read'] }), /not available here \(decide\)/);
  await assert.rejects(callOp('nope', {}, { ctx }), /unknown operation/);
  assert.equal((await callOp('get_status', {}, { ctx, allow: ['read'] })).pending.memory, 1);
});

test('start_run returns at once and the run shows as running, then interrupted when its process is gone', async () => {
  const ctx = fixture();
  const calls = [];
  let pid = process.pid; // alive
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid, unref() {} }; };
  const { run_id, status } = await callOp('start_run', { agent: 'demo', task: 'hello there' }, { ctx: { ...ctx, spawn } });
  assert.equal(status, 'running');
  assert.deepEqual(calls[0].args.slice(1), ['run', '--run-id', run_id, 'demo', 'hello there']);
  assert.equal(calls[0].opts.env.AGENT_HOME, ctx.root);
  assert.equal(listRuns(ctx.state).length, 0, 'receipts only by default');
  assert.equal(listRuns(ctx.state, { running: true }).find((r) => r.run_id === run_id).status, 'running');
  assert.equal((await callOp('get_run', { run_id }, { ctx })).status, 'running');

  pid = 2 ** 22 + 12345; // no such process
  await callOp('start_run', { agent: 'demo', task: 'second' }, { ctx: { ...ctx, spawn } });
  assert.equal(listRuns(ctx.state, { running: true }).at(-1).status, 'interrupted');
  await assert.rejects(callOp('start_run', { agent: 'demo', task: 'q', cwd: ctx.root }, { ctx: { ...ctx, spawn } }), /only allowed/);
});

test('runAgent replaces its running marker with the receipt', async () => {
  const ctx = fixture();
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => {
      assert.equal(listRuns(ctx.state, { running: true })[0].status, 'running');
      child.stdout.end(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} } }) + '\n');
      child.stdout.on('end', () => child.emit('close', 0));
      child.stdout.resume();
    });
    return child;
  };
  const r = await runAgent('demo', 'q', { ...ctx, spawn, runId: 'r-test-1' });
  assert.equal(r.run_id, 'r-test-1');
  assert.equal(fs.existsSync(path.join(ctx.state, 'runs/r-test-1.running')), false);
  assert.deepEqual(listRuns(ctx.state, { running: true }).map((x) => x.status), ['completed']);
});

test('dashboard data and MCP App wiring', async () => {
  const ctx = fixture();
  const data = dashboardData(ctx);
  assert.equal(data.agents[0].name, 'demo');
  assert.equal(data.pending[0].kind, 'memory');

  const tool = toolList().find((t) => t.name === 'open_dashboard');
  assert.equal(tool._meta.ui.resourceUri, DASHBOARD_URI);
  assert.equal(tool._meta['openai/outputTemplate'], DASHBOARD_URI);

  const handle = createServer({ ctx, html: async () => '<html>dash</html>' });
  const call = await handle({ id: 1, method: 'tools/call', params: { name: 'open_dashboard', arguments: {} } });
  assert.match(call.result.content[0].text, /1 agents · 0 running · 1 memory note/);
  assert.equal(call.result.structuredContent.agents[0].name, 'demo');
  const listed = await handle({ id: 2, method: 'resources/list' });
  assert.equal(listed.result.resources[0].mimeType, 'text/html;profile=mcp-app');
  const read = await handle({ id: 3, method: 'resources/read', params: { uri: DASHBOARD_URI } });
  assert.equal(read.result.contents[0].text, '<html>dash</html>');
  assert.equal((await handle({ method: 'notifications/initialized' })), null);
});
