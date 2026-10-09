import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

test('MCP advertises project cwd and validates it before starting an agent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-'));
  fs.mkdirSync(path.join(root, 'agents'));
  for (const [name, workspace] of [['fixed', root], ['local', 'here']]) {
    fs.writeFileSync(path.join(root, 'agents', `${name}.md`), `---\nname: ${name}\nworkspace: ${workspace}\n---\nTest.\n`);
  }
  const child = spawn(process.execPath, [new URL('./mcp.mjs', import.meta.url).pathname], {
    env: { ...process.env, AGENT_HOME: root, AGENT_WORKFLOW_STATE: path.join(root, 'state') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve) => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const listed = await request('tools/list');
  const tool = listed.result.tools.find((x) => x.name === 'run_agent');
  assert.equal(tool.inputSchema.properties.cwd.type, 'string');
  assert.match(tool.description, /absolute cwd/);
  const call = (agent, cwd) => request('tools/call', { name: 'run_agent', arguments: { agent, task: 'q', cwd } });
  for (const [agent, cwd, error] of [
    ['fixed', root, /only allowed/],
    ['local', 'relative', /absolute path/],
    ['local', 123, /absolute path/],
    ['local', os.homedir(), /strictly inside/],
  ]) {
    const response = await call(agent, cwd);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, error);
  }
  assert.equal(fs.existsSync(path.join(root, 'state')), false);
});
