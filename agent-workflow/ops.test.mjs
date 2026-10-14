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
  assert.equal(tool._meta['openai/ui'], undefined, 'only the hosted App owns navigation');
  assert.equal(tool.title, 'Agents on this Mac', 'local entrypoint is distinct from the hosted dashboard');

  const handle = createServer({ ctx, html: async () => '<html>dash</html>' });
  const call = await handle({ id: 1, method: 'tools/call', params: { name: 'open_dashboard', arguments: {} } });
  assert.match(call.result.content[0].text, /1 agents · 0 running · 1 memory note/);
  assert.equal(call.result.structuredContent.agents[0].name, 'demo');
  const listed = await handle({ id: 2, method: 'resources/list' });
  assert.equal(listed.result.resources[0].mimeType, 'text/html;profile=mcp-app');
  const read = await handle({ id: 3, method: 'resources/read', params: { uri: DASHBOARD_URI } });
  assert.equal(read.result.contents[0].text, '<html>dash</html>');
  assert.deepEqual(read.result.contents[0]._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);
  assert.equal((await handle({ method: 'notifications/initialized' })), null);
});

test('local MCP initialize metadata is bounded and attached to later operation context', async () => {
  const ctx = fixture();
  const handle = createServer({ ctx, ops: OPS.filter(o => o.name === 'get_status') });
  const init = await handle({ id: 1, method: 'initialize', params: {
    protocolVersion: '2026-07-28', capabilities: { tools: { listChanged: true }, elicitation: { form: {} }, raw: { token: 'secret' } },
    clientInfo: { name: 'fixture-host', version: '1' },
  }});
  assert.equal(init.result.protocolVersion, '2026-07-28');
  assert.equal(ctx.mcp_connection.protocol_version, '2026-07-28');
  assert.equal(ctx.mcp_connection.capabilities.tools.listChanged, true);
  assert.equal(ctx.mcp_connection.client.name, 'fixture-host');
  assert.doesNotMatch(JSON.stringify(ctx.mcp_connection), /secret/);
});

test('linked open_dashboard uses exactly the Hub lists and falls back explicitly on failure', async () => {
  const ctx = { ...fixture(), hub: { endpoint: 'https://hub.example', token: 't'.repeat(32) } };
  const remote = { source: 'hub', agents: [{ name: 'remote-only' }], runs: [{ run_id: 'r-dok', runner: 'dok' }],
    pending: [{ id: 'm-hub', kind: 'memory', body: 'Hub note' }], status: { agents: 1, running: 0, pending: { memory: 1, proposals: 0 } },
    capabilities: { run: false, mutate: false } };
  const calls = [];
  ctx.fetchImpl = async (url, init) => { calls.push(url); assert.equal(init.method, 'GET'); return Response.json(remote); };
  const data = await callOp('open_dashboard', {}, { ctx });
  assert.deepEqual(data.agents, remote.agents); assert.deepEqual(data.runs, remote.runs); assert.deepEqual(data.pending, remote.pending);
  assert.deepEqual(data.status, remote.status); assert.equal(data.source, 'hub'); assert.equal(data.transport, 'mac');
  assert.match(data.decision_message, /Decide this in the Agents Hub panel/);
  assert.deepEqual(calls, ['https://hub.example/relay/mac/panel'], 'no local merge, cache refresh or outbox flush on this read');
  ctx.fetchImpl = async () => { throw new Error('unreachable'); };
  const fallback = await callOp('open_dashboard', {}, { ctx });
  assert.equal(fallback.source, 'local (Hub unreachable)'); assert.equal(fallback.agents[0].name, 'demo');
  assert.equal(fallback.pending[0].id, 'm-20261009T000000Z-abcdef');
  assert.equal((await callOp('open_dashboard', {}, { ctx: { ...ctx, hub: null } })).source, 'local');
});

test('get_run reads Hub output including dok runs and retains local fallback', async () => {
  const ctx = { ...fixture(), hub: { endpoint: 'https://hub.example', token: 't'.repeat(32) },
    fetchImpl: async (url) => { assert.ok(url.endsWith('/relay/mac/runs/r-dok')); return Response.json({ run_id: 'r-dok', runner: 'dok', status: 'failed', error: 'usage limit reached', output: 'done' }); } };
  const remote = await callOp('get_run', { run_id: 'r-dok' }, { ctx });
  assert.equal(remote.output, 'done');
  assert.equal(remote.failure_guidance.category, 'agent_model');
  assert.match(Object.fromEntries(remote.failure_rows)['Next step'], /reset time/);
  assert.match(Object.fromEntries(remote.trace).Workspace, /Unavailable/);
  fs.mkdirSync(path.join(ctx.state, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.state, 'runs/r-local.json'), JSON.stringify({ run_id: 'r-local', agent: 'demo', status: 'completed', raw_events: '/private', output: 'local' }));
  ctx.fetchImpl = async () => { throw new Error('offline'); };
  const local = await callOp('get_run', { run_id: 'r-local' }, { ctx });
  assert.equal(local.output, 'local'); assert.equal(local.raw_events, undefined);
  assert.match(Object.fromEntries(local.trace).Logs, /Unavailable/);
  assert.doesNotMatch(JSON.stringify(local.trace), /private/);
  fs.writeFileSync(path.join(ctx.state, 'runs/r-local.json'), JSON.stringify({ run_id: 'r-local', agent: 'demo', status: 'failed', error: 'Execution lease refused' }));
  assert.equal((await callOp('get_run', { run_id: 'r-local' }, { ctx })).failure_guidance.category, 'policy_permissions');
});
