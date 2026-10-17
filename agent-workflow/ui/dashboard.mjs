// Builds the dashboard page. In MCP hosts the page talks to the host through the ext-apps `App` bridge, which is
// inlined because host iframes block script URLs. For `agent ui` (a plain browser tab) a small stand-in bridge
// sends the same tool calls to the local web server instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(DIR, 'vendor/ext-apps-2.0.3-app-with-deps.js');
const PLACEHOLDER = '/*__EXT_APPS_BUNDLE__*/';

/** The vendored bundle is an ES module ending in `export{a as App,…}`; expose those names as globalThis.ExtApps. */
export function bridgeScript(source = fs.readFileSync(BUNDLE, 'utf8')) {
  const out = source.replace(/export\s*\{([^}]+)\};?\s*$/, (_, body) => `globalThis.ExtApps={${body.split(',').map((part) => {
    const [local, exported] = part.split(' as ').map((s) => s.trim());
    return `${exported ?? local}:${local}`;
  }).join(',')}};`);
  if (out === source) throw new Error('unexpected ext-apps bundle format (no trailing export)');
  return out;
}

/** Stand-in for the ext-apps App in a normal browser tab: tool calls go to `agent ui` with its per-launch token. */
export function webBridge(token) {
  return `globalThis.ExtApps = { web: true, applyHostStyleVariables: null, App: class {
    async connect() {}
    getHostContext() { return { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }; }
    async callServerTool({ name, arguments: args }) {
      const r = await fetch('/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-ui': ${JSON.stringify(token)} },
        body: JSON.stringify({ name, arguments: args ?? {} }) });
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: 'error: HTTP ' + r.status }] };
      return r.json();
    }
  } };`;
}

let cached;
export function dashboardHtml({ bridge } = {}) {
  const page = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');
  if (!page.includes(PLACEHOLDER)) throw new Error('dashboard.html has no bridge placeholder');
  const health = fs.readFileSync(path.join(DIR, '../health.mjs'), 'utf8').replace(/^export /gm, '');
  const shared = name => fs.readFileSync(path.join(DIR, '../' + name + '.mjs'), 'utf8').replace(/^export /gm, '');
  const recovery = `const { recoveryAction } = (() => { ${shared('recovery-contract')}\nreturn { recoveryAction }; })();`;
  const continuation = `const { publicSourceReview, reviewSource, publicSourcePr, publicReview } = (() => { ${shared('run-continuation')}\nreturn { publicSourceReview, reviewSource, publicSourcePr, publicReview }; })();`;
  const trace = shared('run-trace').replace(/^import .*;\n/gm, '');
  if (!page.includes('/*__HEALTH_BUNDLE__*/')) throw new Error('dashboard.html has no health placeholder');
  return page.replace(PLACEHOLDER, () => bridge ?? (cached ??= bridgeScript()))
    .replace('/*__HEALTH_BUNDLE__*/', () => `${health}\n${recovery}\n${continuation}\n${trace}\nglobalThis.AgentsHealth = { healthOf, healthLabels, dashboardHealth, runTrace, failureRows, progressRows, progressSummary, configurationRows, recoveryAction, publicReview };`);
}
