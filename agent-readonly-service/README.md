# Agents Hub hosted service

A Cloudflare Worker (deployed with the `cf` CLI and `@cloudflare/vite-plugin`): the Agents Hub for ChatGPT, Dots and Claude. It
starts the user's agents on dok (outbound WebSocket to a Durable Object), stores runs, ratings, memory notes and published agent
definitions in D1, serves the review panel, and gives the Mac a limited principal (`/relay/mac/*`). Decisions are only the user's
panel clicks. See `../agent-workflow/RUNNERS.md`.

Live: `https://YOUR-HUB.workers.dev`

| Endpoint | Auth | What |
|---|---|---|
| `GET /health` | none | Service liveness and static capabilities (`run: false, mutate: false`), NOT live relay health |
| `POST /mcp` | OAuth 2.1 bearer token | MCP + Agents Hub dashboard resource: `open_dashboard`, `list_agents`, `list_runs`, `get_run`, `get_status` (plus panel, run and review tools when dok is enabled) |
| `GET /relay/dok-dev/connect` (WebSocket upgrade) | dok machine token | Existing dok supervisor transport |
| `GET /relay/mac/panel`, `/relay/mac/runs/:id` | Mac token | Shared Hub data without confirmation codes |
| `GET /relay/mac/artifacts/:id` | Mac token | Download a completed dok review bundle after receipt/hash verification |
| `PUT /relay/dok-dev/artifacts/:id` | dok machine token | Publish one immutable completed-run review bundle |
| `POST /relay/mac/start` | Mac token | Existing allowed dok starts; only agent, task, request_id |
| `GET /relay/mac/starts/:id` | Mac token | Read-only request reconciliation via receipts and dok journal |

**What is stored:** runner receipts are normalised on arrival (`sanitizeReceipt` in `src/runs.mjs`): unknown fields are dropped and any line that looks like a secret (`src/secrets.mjs`) is redacted. D1 keeps at most 500 runs; archive keeps the panel small long before that.

**Contract:** tool names, schemas and result shapes come from `agent-workflow/contract.mjs`, shared with the local
server. The dashboard (`agent-workflow/ui/dashboard.html`, bridge inlined at build by `vite.config.ts`) uses
Hub D1 runs, definitions and reviews through `nativePanel`; the Mac read route omits confirmation codes.
`get_status` and `open_dashboard` include one-shot runner observations. Unknown telemetry stays unknown;
historical success is not a heartbeat. The UI shows one runner line and collapsible details.

**Live panel (2026-10-14).** The widget polls `panel_data` alone (it carries health and the Development tab). With `since` it gets
`{unchanged, version}` from one batched D1 read plus the runner status, so a hosted panel checks every 2–3 s and does a full read
only on change (and once a minute). Per-run publication/review lookups and confirmation codes are batched. The Worker uses smart
placement near D1. Measured: a new run appears in about 2–4 s (was 60–80 s); see `evidence/2026-10-14-dashboard-latency-after/`.

**Archive (2026-10-14).** The panel reads only unarchived runs (`runs.archived_at IS NULL`, migration 0011), so archived runs cost nothing on each refresh; `get_run` still reads them. Archiving and restoring are the user's clicks (`archive_runs`, one-time `archive` codes per run; `panel_archived` lists archived runs with restore codes). The panel offers suggestions with a reason (merged or closed PR, stopped before doing anything, resumed later, rated and over 7 days old), always for a whole review conversation, groups continuations under their newest run, and filters by agent, status, PR and rating. Status counts and `list_runs` cover unarchived runs.

**Snapshots are removed (2026-10-14).** The publisher was retired on 2026-10-12; the snapshot table (migration 0012), the `/v1/*` REST routes, `resolve_context` and the snapshot readers are gone, and every read comes from D1. The Mac posts receipts and reads memory through its own principal
(`/relay/mac/*`, secret `MAC_TOKEN`, file `~/.config/agent-readonly/mac.json`), which can post receipts, read bundles, pending
notes and decisions, and publish committed definitions (`agent sync push`), and request existing allowed dok starts, but cannot rate, decide or start anything on the Mac.

**Sign-in:** Cloudflare Access is the OAuth server (Managed OAuth on the "Agents Hub MCP" Access application, path
`/mcp`, owner-only policy): clients get a 401 with Access's metadata, register themselves (redirects limited to
chatgpt.com, claude.ai, claude.com and loopback), sign in with the Access email code and get a 15-minute token
(refresh for 30 days). The Worker has no OAuth code; it verifies the `Cf-Access-Jwt-Assertion` on every `/mcp`
request (`src/access.mjs`), so preview URLs or a missing Access app fail closed. `/health` and the token-authenticated
`/relay/*` routes are outside Access. Evidence: `evidence/2026-10-09-agents-hub-managed-oauth/`.
The former OAuth KV namespace was deleted on 2026-10-09.

Tests: `npm test`. Deploy: `cf deploy` (check with `cf deploy --dry-run` first). Deployment values (Worker name, Access issuer and AUD, D1 and R2 names) are read from `HUB_CONFIG` (default `~/.config/agents-hub/hub.json`, shape in `hub.example.json`); `HUB_NAME`, `HUB_ACCESS_ISSUER` and `HUB_ACCESS_AUD` override single values.

With the dok runner configured, MCP advertises hosted `start_run`, `get_remote_run` and app-only
`panel_data`, `panel_run`, `rate_run`, `review_decide`. The Worker requires a verified Access assertion
for user MCP calls. dok uses its separate machine credential outside Access. The DO alarm expires
transient requests; durable recovery uses existing dok journals and D1 receipts, with no second run database.
The new Mac start route reserves a `mac-` request namespace, rejects model/repository/configuration overrides,
and uses the same dispatcher and supervisor admission checks. Status includes pending start attempts;
older retained operations without an operation label are counted conservatively. Existing decision checks
and confirmation-code boundaries remain unchanged. See `../agent-workflow/README.md` for recovery semantics.

## GitHub review publication (2026-10-14)

The separate [review publisher](../tools/review-publisher/README.md) automatically exports enabled repository reviews as draft PRs and supplies fresh GitHub bases for independent runs. Pi receives no GitHub credential. Published follow-ups fetch the current PR head (including reviewer fixes) and update the same PR. Historical run snapshots remain immutable. Hub migrations 0008 and 0009, a dedicated publisher secret, an explicit repository activation cutoff and the runner socket configuration are required. `publish_review` retries publication without rerunning the agent.
