# Agents Hub hosted service

A Cloudflare Worker (deployed with the `cf` CLI and `@cloudflare/vite-plugin`) that serves the authenticated,
sanitized, read-only Agents Hub view of local agents and recent runs to ChatGPT and Dots. Local Pi stays the only
place agents run; this service cannot run agents or change anything.

Live: `https://YOUR-HUB.workers.dev`

| Endpoint | Auth | What |
|---|---|---|
| `GET /health` | none | Liveness and capabilities (`execute: false, mutate: false`) |
| `POST /mcp` | OAuth 2.1 bearer token | MCP + Agents Hub dashboard resource: `open_dashboard`, `list_agents`, `list_runs`, `get_run`, `get_status`, `resolve_context` |
| `GET /mcp/v1/agents[/:name]`, `/mcp/v1/runs[/:id]`, `/mcp/v1/context` | OAuth 2.1 bearer token | The same data as REST, beneath the `/mcp` resource |
| `POST /v1/snapshots` | Bearer publish token | Used only by `publisher.mjs`; keeps the newest 20 snapshots |

**What is published** (`src/snapshot.mjs`): agent name, description, model, tools, skill names, guard, workspace (with
`~`); per run: id, agent, kind, status, a title (first line of the task, at most 120 characters, never the full
prompt), timestamps, model, counts, tokens, cost and your rating; and how many memory notes and proposals wait for
review (counts only, never their text). Any value that looks like a secret is redacted in place. Data is stale after
15 minutes without a publish. Sanitizing is idempotent: the publisher and the Worker both run it.

**Contract:** tool names, schemas and result shapes come from `agent-workflow/contract.mjs`, shared with the local
server, so the one dashboard (`agent-workflow/ui/dashboard.html`, bridge inlined at build by `vite.config.ts`) reads
both. Hosted results add `snapshot: { published_at, generated_at, stale }`; review counts that were not published are
`null` and shown as unknown, not zero.

**Publishing:** `agent` publishes in the background after every run and chat when
`~/.config/agent-readonly/publish.env` exists (`AGENT_READONLY_ENDPOINT`, `AGENT_PUBLISH_TOKEN`; log in
`~/.local/state/agent-workflow/publish.log`). By hand: `node publisher.mjs` or `node publisher.mjs --dry-run` to see
exactly what would be sent. Set `AGENT_PUBLISH=0` to skip.

**Sign-in:** Cloudflare Access is the OAuth server (Managed OAuth on the "Agents Hub MCP" Access application, path
`/mcp`, owner-only policy): clients get a 401 with Access's metadata, register themselves (redirects limited to
chatgpt.com, claude.ai, claude.com and loopback), sign in with the Access email code and get a 15-minute token
(refresh for 30 days). The Worker has no OAuth code; it verifies the `Cf-Access-Jwt-Assertion` on every `/mcp`
request (`src/access.mjs`), so preview URLs or a missing Access app fail closed. `/health` and `/v1/snapshots`
(publisher token in `~/.config/agent-readonly/`) are outside Access. Evidence: `evidence/2026-10-09-agents-hub-managed-oauth/`.
The old OAuth KV namespace is no longer bound and can be deleted.

Tests: `npm test`. Deploy: `cf deploy` (check with `cf deploy --dry-run` first).
