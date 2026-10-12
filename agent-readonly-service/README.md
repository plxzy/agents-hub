# Agents Hub hosted service

A Cloudflare Worker (deployed with the `cf` CLI and `@cloudflare/vite-plugin`): the Agents Hub for ChatGPT, Dots and Claude. It
starts the user's agents on dok (outbound WebSocket to a Durable Object), stores runs, ratings, memory notes and published agent
definitions in D1, serves the review panel, and gives the Mac a limited principal (`/relay/mac/*`). Decisions are only the user's
panel clicks. See `../agent-workflow/RUNNERS.md`.

Live: `https://YOUR-HUB.workers.dev`

| Endpoint | Auth | What |
|---|---|---|
| `GET /health` | none | Service liveness and static snapshot-surface capabilities (`run: false, mutate: false`), NOT live relay health |
| `POST /mcp` | OAuth 2.1 bearer token | MCP + Agents Hub dashboard resource: `open_dashboard`, `list_agents`, `list_runs`, `get_run`, `get_status`, `resolve_context` |
| `GET /mcp/v1/agents[/:name]`, `/mcp/v1/runs[/:id]`, `/mcp/v1/context` | OAuth 2.1 bearer token | The same data as REST, beneath the `/mcp` resource |
| `GET /relay/dok-dev/connect` (WebSocket upgrade) | dok machine token | Existing dok supervisor transport |
| `GET /relay/mac/panel`, `/relay/mac/runs/:id` | Mac token | Shared Hub data without confirmation codes |
| `POST /relay/mac/start` | Mac token | Existing allowed dok starts; only agent, task, request_id |
| `GET /relay/mac/starts/:id` | Mac token | Read-only request reconciliation via receipts and dok journal |
| `POST /v1/snapshots` | Bearer publish token | Retired with the publisher; closed by deleting `PUBLISH_TOKEN` |

**What is published** (`src/snapshot.mjs`): agent name, description, model, tools, skill names, guard, workspace (with
`~`); per run: id, agent, kind, status, a title (first line of the task, at most 120 characters, never the full
prompt), timestamps, model, counts, tokens, cost and your rating; and how many memory notes and proposals wait for
review (counts only, never their text). Any value that looks like a secret is redacted in place. Data is stale after
15 minutes without a publish. Sanitizing is idempotent: the publisher and the Worker both run it.

**Contract:** tool names, schemas and result shapes come from `agent-workflow/contract.mjs`, shared with the local
server. The dashboard (`agent-workflow/ui/dashboard.html`, bridge inlined at build by `vite.config.ts`) uses
Hub D1 runs, definitions and reviews through `nativePanel`; the Mac read route omits confirmation codes.
`get_status` and `open_dashboard` include one-shot runner observations. Unknown telemetry stays unknown;
historical success is not a heartbeat. The UI shows one runner line and collapsible details.
Legacy snapshot fallback readers still exist, but their timestamps are no longer dashboard health bubbles.

**Snapshots are retired (2026-10-12).** `agent` no longer publishes snapshots and `publisher.mjs` is gone; the Hub reads runs,
ratings, memory notes, agent definitions and counts from D1. `POST /v1/snapshots` and the snapshot readers remain only as a
fallback for the old data; delete the `PUBLISH_TOKEN` secret to close the endpoint (done after this change), then the
snapshot code and the `snapshots` table can be removed. The Mac posts receipts and reads memory through its own principal
(`/relay/mac/*`, secret `MAC_TOKEN`, file `~/.config/agent-readonly/mac.json`), which can post receipts, read bundles, pending
notes and decisions, and publish committed definitions (`agent sync push`), and request existing allowed dok starts, but cannot rate, decide or start anything on the Mac.

**Sign-in:** Cloudflare Access is the OAuth server (Managed OAuth on the "Agents Hub MCP" Access application, path
`/mcp`, owner-only policy): clients get a 401 with Access's metadata, register themselves (redirects limited to
chatgpt.com, claude.ai, claude.com and loopback), sign in with the Access email code and get a 15-minute token
(refresh for 30 days). The Worker has no OAuth code; it verifies the `Cf-Access-Jwt-Assertion` on every `/mcp`
request (`src/access.mjs`), so preview URLs or a missing Access app fail closed. `/health` and `/v1/snapshots`
(publisher token in `~/.config/agent-readonly/`) are outside Access. Evidence: `evidence/2026-10-09-agents-hub-managed-oauth/`.
The former OAuth KV namespace was deleted on 2026-10-09.

Tests: `npm test`. Deploy: `cf deploy` (check with `cf deploy --dry-run` first).

With the dok runner configured, MCP advertises hosted `start_run`, `get_remote_run` and app-only
`panel_data`, `panel_run`, `rate_run`, `review_decide`. The Worker requires a verified Access assertion
for user MCP calls. dok uses its separate machine credential outside Access. The DO alarm expires
transient requests; durable recovery uses existing dok journals and D1 receipts, with no second run database.
The new Mac start route reserves a `mac-` request namespace, rejects model/repository/configuration overrides,
and uses the same dispatcher and supervisor admission checks. Status includes pending start attempts;
older retained operations without an operation label are counted conservatively. Existing decision checks
and confirmation-code boundaries remain unchanged. See `../agent-workflow/README.md` for recovery semantics.
