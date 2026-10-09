#!/usr/bin/env node
// Local stdio MCP server that lets other apps (Claude Code/Desktop, Codex, Pi, ChatGPT via a local bridge) use the
// agents in AGENT_HOME. Tools come from the operations catalog (ops.mjs); hosts that render MCP Apps (Claude Desktop,
// claude.ai, ChatGPT, the Codex app) also get the dashboard. JSON-RPC over stdio, no MCP SDK.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_URI, OPS, defaultContext } from './ops.mjs';
import { DASHBOARD_TOOL_META, DASHBOARD_RESOURCE_META, DASHBOARD_ICONS } from './contract.mjs';

const MCP_APP_MIME = 'text/html;profile=mcp-app';
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** MCP tool definitions for a set of operations; ops with a dashboard point hosts at it (MCP Apps + ChatGPT alias). */
export function toolList(ops = OPS) {
  return ops.map((op) => ({
    name: op.name, title: op.title, description: op.description, inputSchema: op.input, annotations: { title: op.title, ...op.annotations },
    ...(op.ui ? { icons: DASHBOARD_ICONS, _meta: DASHBOARD_TOOL_META } : {}),
  }));
}

export async function callTool(op, args, ctx) {
  try {
    const value = await op.run(args ?? {}, ctx);
    // Dashboard ops hand the widget structured data and give the model (and hosts without UI) a short summary.
    if (op.ui) return { content: [{ type: 'text', text: op.summary(value) }], structuredContent: value };
    return { content: [{ type: 'text', text: asText(value) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true };
  }
}

export function createServer({ ctx = defaultContext(), ops = OPS, html = () => import('./ui/dashboard.mjs').then((m) => m.dashboardHtml()) } = {}) {
  return async function handle({ id, method, params }) {
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'agents-hub', title: 'Agents Hub', version: '0.3.0' },
        instructions: "The user's own agents (Pi, local). Use run_agent to delegate to a matching agent; list_agents shows what exists; "
          + 'open_dashboard shows everything at a glance. Ratings and proposal decisions belong to the user: only pass them on when the user states them.' });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: toolList(ops) });
    if (method === 'tools/call') {
      const op = ops.find((o) => o.name === params?.name);
      if (!op) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
      return reply(await callTool(op, params.arguments, ctx));
    }
    if (method === 'resources/list') {
      return reply({ resources: [{ uri: DASHBOARD_URI, name: 'Agents dashboard', mimeType: MCP_APP_MIME }] });
    }
    if (method === 'resources/read') {
      if (params?.uri !== DASHBOARD_URI) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown resource ${params?.uri}` } };
      return reply({ contents: [{ uri: DASHBOARD_URI, mimeType: MCP_APP_MIME, text: await html(),
        _meta: DASHBOARD_RESOURCE_META }] });
    }
    if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    return null; // notifications
  };
}

export function serveStdio(handle = createServer()) {
  const send = (msg) => msg && process.stdout.write(JSON.stringify(msg) + '\n');
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      handle(msg).then(send, (e) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
    }
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) serveStdio();
