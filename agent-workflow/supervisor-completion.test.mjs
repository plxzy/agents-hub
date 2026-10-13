// Exercises the production preparation, IPC, export and finalization callbacks with controlled
// process/sandbox boundaries. Real Linux namespace acceptance remains a separate test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DevelopmentSessions } from './dev-sessions.mjs';
import { save, read } from './durable-file.mjs';

test('supervisor completes through actual child callbacks without deleting failed work', async t => {
  for (const outcome of ['success', 'model_error', 'crash', 'export_error']) for (const connection of [false, true]) {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-completion-'));
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const id = 'r-20261013T000000Z-abcdef', workspace = path.join(state, 'run-work', id, 'workspace');
    for (const dir of ['agent-runs', 'recovery-v1', 'knowledge']) fs.mkdirSync(path.join(state, dir));
    save(path.join(state, 'knowledge', 'RELEASE.json'), { source_revision: 'knowledge' });
    const runtime = { engine: 'pi-sdk', provider: 'openai', model: 'gpt-6-luna', thinking: 'low' };
    const observed = { ...runtime, pi_version: '1.1.0' };
    const agent = { name: 'demo', version: 'v1', tools: ['read', 'write'], skills: 'none', memory: [], instructions: 'Test', workspace: '/repo' };
    const receipt = { run_id: id, root: id, agent: 'demo', repo: 'demo', write: true, status: 'running', task: 'Fixture task',
      ...(connection ? { mcp_connection: { protocol_version: '2025-11-25', capabilities: {} } } : {}) };
    save(path.join(state, 'agent-runs', id + '.json'), receipt);
    let resolve;
    const completed = new Promise(r => { resolve = r; });
    const host = Object.assign(Object.create(DevelopmentSessions.prototype), {
      state, revision: 'release', repos: { demo: '/unused/repo.git' }, knowledge: path.join(state, 'knowledge'),
      limits: { slots: ['openai'], writeMs: 10000, diskBytes: 1024 ** 3 }, runs: new Map([[id, { repo: 'demo', write: true }], ['other', { repo: 'other' }]]),
      poolSlots: async () => ['openai'], prune() {},
      report: async () => { const r = read(path.join(state, 'agent-runs', id + '.json')); if (r.status !== 'running') resolve(r); },
      harvest: async () => { if (outcome === 'export_error') throw Error('Export failed'); return { commit: 'b'.repeat(40), review_ref: `refs/heads/review/runs/${id}`, changed_files: ['a'] }; },
      runIO: {
        execFileSync(_cmd, args) { if (args.includes('clone')) { fs.mkdirSync(path.join(workspace, '.git'), { recursive: true }); return ''; } return 'a'.repeat(40); },
        linuxPolicy: agent => ({ workspace: agent.workspace }), sandboxExecute: async () => ({}),
        spawn() {
          const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
          child.stdin = new PassThrough(); child.kill = () => {};
          child.stdin.on('finish', () => queueMicrotask(() => {
            child.emit('message', { type: 'runtime', runtime: observed });
            child.emit('message', { type: 'checkpoint', partial: { output: 'Earlier output' } });
            if (outcome !== 'crash') child.stdout.write(JSON.stringify({ runtime: observed, output: 'Completed answer', tool_calls: ['read'],
              ...(outcome === 'model_error' ? { error: 'model turn failed' } : {}) }));
            child.emit('close', ['success', 'export_error'].includes(outcome) ? 0 : 1);
          }));
          return child;
        },
      },
    });
    const timeout = setTimeout(() => resolve({ status: 'test_timeout' }), 2000);
    await host.executeRun(agent, runtime, receipt);
    const final = await completed; clearTimeout(timeout);
    assert.equal(final.status, outcome === 'success' ? 'completed' : ['crash', 'export_error'].includes(outcome) ? 'interrupted' : 'failed', outcome);
    assert.equal(final.output, outcome === 'crash' ? 'Earlier output' : 'Completed answer');
    assert.equal(Boolean(final.configuration.mcp_connection), connection);
    assert.equal(fs.existsSync(workspace), outcome !== 'success');
    assert.deepEqual([...host.runs.keys()], ['other']);
  }
});
