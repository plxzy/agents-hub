# plugins

One plugin folder, `agents/`, for every app that can load it. It holds no logic: the tools come from
`agent-workflow/mcp.mjs`, which is built from the operations catalog `agent-workflow/ops.mjs`.

| App | What it loads | How it gets here |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `skills/`, `commands/` (`/agents`). No `.mcp.json` since 2026-10-12: Claude Code uses the hosted **Agents Hub** connector (one entry; works with the Mac off) | `claude plugin marketplace add ~/Development/dev-workflow/plugins` → `claude plugin install agents@dev-workflow` |
| Codex (CLI and app) | `plugin.json` (Agent Plugins 1.0), `mcp.json`, `skills/` | `codex plugin marketplace add ~/Development/dev-workflow/plugins` (reads `.agents/plugins/marketplace.json`) |
| Pi | `package.json` `"pi"` → `pi/agents.ts`: registers the MCP server, `/agents`, footer status | `pi install ~/Development/dev-workflow/plugins/agents` |
| Claude Desktop chat, claude.ai, mobile | the hosted Agents Hub as a claude.ai custom connector (`…workers.dev/mcp`, Access OAuth) | the local `agents` entry in `claude_desktop_config.json` was removed 2026-10-09 (backup in `~/.local/state/agent-workflow/backups/`) so the Code tab no longer lists the local server twice |

The **Agents Hub** dashboard (`open_dashboard`) renders in hosts that support MCP Apps: Claude Desktop, claude.ai,
ChatGPT and the Codex app. Claude Code and Pi get the same tools as text. Without any app: `agent ui`.

Paths in `mcp.json` (Codex) are absolute because Claude Code and Codex copy installed plugins into a cache,
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
the terminal and the desktop Code tab. Header chips (agents, running, to review) and four tabs:
**Runs** (the Hub's latest 50 runs, including dok; press one for its output as Markdown with model, duration, tool calls),
**Review** (Hub items are read-only and say “Decide this in the Agents Hub panel”), **Start a run** (labelled
“Runs on this Mac”; pick a local agent and type a task; agents that work "here" use the session's folder), and
**Agents** (name, description and a link to the last run). Local reviews on an unlinked Mac still have Accept/Reject.
Footer status shows running/to review. Refreshes every 4 s while a Hub run is going (the open run's output follows it),
otherwise every 30 s; `/agents-panel` reopens it; hotkeys r, 1–4, b while it has focus.
On mobile (no text fields) local Reject skips the reason and Start is hidden.
It draws only: data comes from `agent call open_dashboard | get_run | list_agents | start_run | review_decide`
(the operations catalog). On a linked Mac, `open_dashboard` reads `GET /relay/mac/panel` with the Mac's token;
the hosted HTML panel uses the same Hub data. The Mac route never issues or returns one-time confirmation codes.
If the Hub cannot be reached, the panel loads local data labelled `local (Hub unreachable)`. Cached Hub reviews
remain read-only. Mac starts stay local, publish running status and a 15-second heartbeat, then replace that row with the final
receipt. After 90 seconds without contact the Hub shows unknown and stops counting the run as active. See `../agent-workflow/README.md` for the receipt evidence and read routes.
Claude Code only: Codex and ChatGPT panels need their own extension format, using the same operations.

Check: `claude plugin validate plugins/agents-panel` and `claude plugin test plugins/agents-panel`.
Install: `claude plugin install agents-panel@dev-workflow` (after `claude plugin marketplace update dev-workflow`).

**Applying an update in Claude Desktop Code (verified 13 October 2026):** refreshing the hosted connector's
tool list does not update this local mod. Run `claude plugin update agents-panel@dev-workflow --scope user`
(and `claude plugin update agents@dev-workflow --scope user` for its companion), then open a fresh Code
session and run `/agents-panel`. In the tested desktop, `/reload-plugins --force` reported success but an
existing session kept the old renderer. `claude plugin list` displayed the current source version even
while the installation record still pointed to the old cached version; the update command's result and
visible **Source: Agents Hub** / **Agents** tab establish that the new panel loaded. Evidence:
`../evidence/2026-10-13-claude-panel-activation/README.md`.

## Hosted Agents Hub (account App)

ChatGPT, Dots and claude.ai connect to `https://YOUR-HUB.workers.dev/mcp` as an account App /
custom connector with OAuth (Cloudflare Access Managed OAuth). dok runs agents; the Hub's D1 holds runs,
ratings, memory and agent definitions. See `../agent-workflow/RUNNERS.md`.
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
(4 seconds for a running task), pauses when hidden, and retries after refresh errors. Hosted `panel_data` reads
the Hub independently of the Mac. Counts and lists share their implementation with the Mac's read-only route.
Runner health is one line (`dok online · runs: helper, tikkytracker, vm, workflow`, or `dok offline`), with
diagnostics inside a collapsible disclosure. Missing observations are labelled unknown.

Specification: https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#mcp-app-entrypoints
