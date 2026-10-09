# plugins

One plugin folder, `agents/`, for every app that can load it. It holds no logic: the tools come from
`agent-workflow/mcp.mjs`, which is built from the operations catalog `agent-workflow/ops.mjs`.

| App | What it loads | How it gets here |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, `commands/` (`/agents`) | `claude plugin marketplace add ~/Development/dev-workflow/plugins` → `claude plugin install agents@dev-workflow` |
| Codex (CLI and app) | `plugin.json` (Agent Plugins 1.0), `mcp.json`, `skills/` | `codex plugin marketplace add ~/Development/dev-workflow/plugins` (reads `.agents/plugins/marketplace.json`) |
| Pi | `package.json` `"pi"` → `pi/agents.ts`: registers the MCP server, `/agents`, footer status | `pi install ~/Development/dev-workflow/plugins/agents` |
| Claude Desktop | its own config entry (chat ignores a plugin's local MCP servers) | already set up: `agents` in `claude_desktop_config.json` |

The dashboard (`open_dashboard`) renders in hosts that support MCP Apps: Claude Desktop, claude.ai, ChatGPT and the
Codex app. Claude Code and Pi get the same tools as text. Without any app: `agent ui`.

Paths in `.mcp.json`/`mcp.json` are absolute because Claude Code and Codex copy installed plugins into a cache,
from where `${CLAUDE_PLUGIN_ROOT}` cannot reach this repo. Pi loads the package in place, so `pi/agents.ts`
uses relative paths. In Pi processes that `agent` starts for an agent (`AGENT_RUN=1`) the extension does nothing.

After changing the plugin: bump `version` in both manifests, then update it in each app
(`claude plugin update agents@dev-workflow`, `codex plugin marketplace upgrade dev-workflow`; Pi reads the folder).
