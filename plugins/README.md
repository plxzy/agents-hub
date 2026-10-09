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

## `agents-hub/`: hosted OAuth connection

A private remote plugin for the read-only Cloudflare service. It connects to
`https://YOUR-HUB.workers.dev/mcp` using native OAuth and owner-only Cloudflare Access.

Private plugin: https://chatgpt.com/plugins/plugins_6ac8a29d576c8191aa112562b4131771
Package version in this folder: `0.3.2` (display name "Agents Hub (read-only)"). The live ChatGPT release is still
`0.3.1` ("Agents Hub") until this folder is uploaded again.

## Which one to use (two plugins on purpose)

| | `agents` → **Agents Hub (this Mac)** | `agents-hub` → **Agents Hub (read-only)** |
|---|---|---|
| Where | Claude Code, Codex CLI/app, Pi, Claude Desktop (config entry) | ChatGPT web/mobile, Dots, claude.ai (later) |
| Connection | stdio, `agent-workflow/mcp.mjs` on this Mac | HTTPS + OAuth to the Worker |
| Data | live | last published snapshot (titles and counts; stale after 15 min) |
| Can | read, run, review (your clicks) | read only |

Both answer the same read operations with the same result shapes (`agent-workflow/contract.mjs`) and render the
same dashboard; the hosted one shows the snapshot's age and never shows a task's full text. In the Codex app both can
appear, because ChatGPT plugins are account-wide: on the Mac use "this Mac".
