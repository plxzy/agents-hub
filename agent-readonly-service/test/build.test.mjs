import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');

test('Agents Hub dashboard has one canonical tracked source', () => {
  const canonical = path.join(root, 'agent-workflow/ui/dashboard.html');
  assert.ok(fs.existsSync(canonical));
  assert.match(fs.readFileSync(canonical, 'utf8'), /Agents Hub/);
  assert.equal(fs.existsSync(path.join(root, 'agent-readonly-service/ui/dashboard.html')), false);
  assert.match(fs.readFileSync(path.join(root, 'agent-readonly-service/vite.config.ts'), 'utf8'), /agent-workflow\/ui\/dashboard\.mjs/);
});

test('hosted worker delegates OAuth protocol handling to Cloudflare provider', () => {
  const source = fs.readFileSync(path.join(root, 'agent-readonly-service/src/worker.mjs'), 'utf8');
  assert.match(source, /@cloudflare\/workers-oauth-provider/);
  assert.doesNotMatch(source, /startsWith\('\/mcp\/'\)/);
  assert.doesNotMatch(source, /READ_TOKEN/);
});

test('the hosted page gets the MCP Apps bridge inlined, like the local one', async () => {
  const { dashboardHtml } = await import('../../agent-workflow/ui/dashboard.mjs');
  const html = dashboardHtml();
  assert.doesNotMatch(html, /__EXT_APPS_BUNDLE__/);
  assert.match(html, /globalThis\.ExtApps=\{/);
  assert.match(fs.readFileSync(path.join(root, 'agent-readonly-service/vite.config.ts'), 'utf8'), /dashboardHtml\(\)/);
});
