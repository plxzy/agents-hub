# Read-only agent service

A Cloudflare Worker (deployed with the `cf` CLI and `@cloudflare/vite-plugin`) that serves a sanitized, read-only
view of the local agents and their recent runs to hosted clients (ChatGPT Chat, Dots). Local Pi stays the only
place agents run; this service cannot run agents or change anything.

Live: `https://agent-readonly.YOUR-ACCOUNT.workers.dev`

| Endpoint | Auth | What |
|---|---|---|
| `GET /health` | none | Liveness and capabilities (`execute: false, mutate: false`) |
| `POST /mcp` | `Authorization: Bearer <read token>` | MCP (streamable HTTP, JSON responses): `list_agents`, `list_runs`, `get_run`, `get_status` |
| `POST /mcp/<read token>` | token in the URL | Same, for hosts that can only store a URL. Treat that URL as a secret |
| `GET /v1/agents[/:name]`, `/v1/runs[/:id]`, `/v1/context` | Bearer read token | The same data as REST |
| `POST /v1/snapshots` | Bearer publish token | Used only by `publisher.mjs`; keeps the newest 20 snapshots |

**What is published** (`src/snapshot.mjs`): agent name, description, model, tools, skill names, guard, workspace (with
`~`); per run: id, agent, kind, status, a title (first line of the task, at most 120 characters, never the full
prompt), timestamps, model, counts, tokens, cost and your rating. Any value that looks like a secret is redacted in
place. Data is stale after 15 minutes without a publish.

**Publishing:** `agent` publishes in the background after every run and chat when
`~/.config/agent-readonly/publish.env` exists (`AGENT_READONLY_ENDPOINT`, `AGENT_PUBLISH_TOKEN`; log in
`~/.local/state/agent-workflow/publish.log`). By hand: `node publisher.mjs` or `node publisher.mjs --dry-run` to see
exactly what would be sent. Set `AGENT_PUBLISH=0` to skip.

**Tokens** live only in `~/.config/agent-readonly/` (mode 600; `read.env` holds the read token for setting up a
client). The agent sandbox cannot read that folder and the workspace guard blocks it. Rotated 2026-10-09 by Claude
Code: new random tokens set with `cf deploy --secrets-file` (file deleted afterwards).

Tests: `npm test`. Deploy: `cf deploy` (check with `cf deploy --dry-run` first).
