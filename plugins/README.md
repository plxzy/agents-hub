# plugins

One plugin folder, `agents/`, for every app that can load it. It holds no logic: the tools come from
`agent-workflow/mcp.mjs`, which is built from the operations catalog `agent-workflow/ops.mjs`.

| App | What it loads | How it gets here |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, `commands/` (`/agents`) | `claude plugin marketplace add ~/Development/dev-workflow/plugins` → `claude plugin install agents@dev-workflow` |
| Codex (CLI and app) | `plugin.json` (Agent Plugins 1.0), `mcp.json`, `skills/` | `codex plugin marketplace add ~/Development/dev-workflow/plugins` (reads `.agents/plugins/marketplace.json`) |
| Pi | `package.json` `"pi"` → `pi/agents.ts`: registers the MCP server, `/agents`, footer status | `pi install ~/Development/dev-workflow/plugins/agents` |
| Claude Desktop | its own config entry (chat ignores a plugin's local MCP servers) | already set up: `agents` in `claude_desktop_config.json` |

The **Agents Hub** dashboard (`open_dashboard`) renders in hosts that support MCP Apps: Claude Desktop, claude.ai,
ChatGPT and the Codex app. Claude Code and Pi get the same tools as text. Without any app: `agent ui`.

Paths in `.mcp.json`/`mcp.json` are absolute because Claude Code and Codex copy installed plugins into a cache,
from where `${CLAUDE_PLUGIN_ROOT}` cannot reach this repo. Pi loads the package in place, so `pi/agents.ts`
uses relative paths. In Pi processes that `agent` starts for an agent (`AGENT_RUN=1`) the extension does nothing.

After changing the plugin: bump `version` in both manifests, then update it in each app
(`claude plugin update agents@dev-workflow`, `codex plugin marketplace upgrade dev-workflow`; Pi reads the folder).

Installed 2026-10-09 in all three (configs backed up in `~/.local/state/agent-workflow/backups/`). Claude Code's
hand-added user-scope `agents` server was removed (the plugin's `plugin:agents:agents` replaces it). Codex keeps
its `[mcp_servers.agents]` entry: it has the same name, so Codex lists one server, and it carries
`tool_timeout_sec = 900`, which long `run_agent` calls need.

## `agents-panel/`: a side panel in Claude Code (a mod)

A Claude Code mod (hooks module, `hooks/register.tsx`): a docked **Agents** pane beside the conversation in
the terminal and the desktop Code tab. Header chips (agents, running, to review) and three tabs:
**Runs** (running and the last 10 runs; press one for its output as Markdown with model, duration, tool calls),
**Review** (memory and proposals as cards: Accept, or Reject with an optional reason) and **Start a run** (pick an
agent, type a task; agents that work "here" run in the session's folder). Accept, Reject and Start are your clicks;
the model never sees them. Footer status shows running/to review. Refreshes every 4 s while a run is going (the open
run's output follows it), otherwise every 30 s; `/agents-panel` reopens it; hotkeys r, 1–3, b while it has focus.
On mobile (no text fields) Reject skips the reason and Start is hidden.
It draws only: data comes from `agent call open_dashboard | get_run | review_decide` (the operations catalog).
Claude Code only: Codex and ChatGPT panels need their own extension format, using the same operations.

Check: `claude plugin validate plugins/agents-panel` and `claude plugin test plugins/agents-panel`.
Install: `claude plugin install agents-panel@dev-workflow` (after `claude plugin marketplace update dev-workflow`).

## Hosted Agents Hub (account App)

ChatGPT, Dots and claude.ai connect to `https://YOUR-HUB.workers.dev/mcp` as an account App /
custom connector with OAuth (Cloudflare Access Managed OAuth). It provides published snapshots and, while
`agent link` is online, live panel data and explicitly allowed Mac runs. See `../agent-workflow/LINK.md`.
The former `agents-hub` plugin package (read-only remote plugin) was removed on 2026-10-09; the user uninstalled it.

## ChatGPT/Codex panel (MCP Extensions)

The hosted App advertises `open_dashboard` as a **global** navigation entry and a **thread** content-tab entry,
named **Agents Hub dashboard**. Local MCP retains its inline widget but advertises no extra navigation entry.
These open the same dashboard without asking a model to call a tool. The host
chooses placement: the global entry opens a permanent app tab with a conversation, and the thread entry opens
beside the current conversation. The normal inline widget still works in other MCP Apps hosts.

Hosted entrypoint metadata lives in `agent-workflow/contract.mjs`. No extra plugin package
or App registration is needed. After deployment, use **Manage → Refresh tools** on the existing hosted App;
local MCP processes must reconnect to discover updated tool metadata. The panel refreshes every 30 seconds
(4 seconds for a local running task), pauses when hidden, and retries after refresh errors. Hosted data still
comes from the linked Mac when online, otherwise the last publication with its age and offline status.

Specification: https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#mcp-app-entrypoints
