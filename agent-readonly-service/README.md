# Agents Hub hosted service

A Cloudflare Worker (deployed with the `cf` CLI and `@cloudflare/vite-plugin`) that serves the authenticated,
sanitized, read-only Agents Hub view of local agents and recent runs to ChatGPT and Dots. Local Pi stays the only
place agents run; this service cannot run agents or change anything.

Live: `https://YOUR-HUB.workers.dev`

| Endpoint | Auth | What |
|---|---|---|
| `GET /health` | none | Liveness and capabilities (`execute: false, mutate: false`) |
| `POST /mcp` | OAuth 2.1 bearer token | MCP + Agents Hub dashboard resource: `open_dashboard`, `list_agents`, `list_runs`, `get_run`, `get_status`, `resolve_context` |
| `GET /v1/agents[/:name]`, `/v1/runs[/:id]`, `/v1/context` | OAuth 2.1 bearer token | The same data as REST |
| `POST /v1/snapshots` | Bearer publish token | Used only by `publisher.mjs`; keeps the newest 20 snapshots |

**What is published** (`src/snapshot.mjs`): agent name, description, model, tools, skill names, guard, workspace (with
`~`); per run: id, agent, kind, status, a title (first line of the task, at most 120 characters, never the full
prompt), timestamps, model, counts, tokens, cost and your rating. Any value that looks like a secret is redacted in
place. Data is stale after 15 minutes without a publish.

**Publishing:** `agent` publishes in the background after every run and chat when
`~/.config/agent-readonly/publish.env` exists (`AGENT_READONLY_ENDPOINT`, `AGENT_PUBLISH_TOKEN`; log in
`~/.local/state/agent-workflow/publish.log`). By hand: `node publisher.mjs` or `node publisher.mjs --dry-run` to see
exactly what would be sent. Set `AGENT_PUBLISH=0` to skip.

OAuth state and grants live in the bound Workers KV namespace. The publisher credential remains only in
`~/.config/agent-readonly/` (mode 600); the agent sandbox cannot read that folder and the workspace guard blocks it.
The former read token and URL-token route are retired during the Agents Hub cutover.

Tests: `npm test`. Deploy: `cf deploy` (check with `cf deploy --dry-run` first).
