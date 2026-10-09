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

OAuth state and grants live in the bound Workers KV namespace. The publisher credential remains only in
`~/.config/agent-readonly/` (mode 600); the agent sandbox cannot read that folder and the workspace guard blocks it.
The former read token and URL-token route are retired during the Agents Hub cutover.

Cloudflare Access protects only `/authorize`, with an owner-only email policy. Discovery, registration,
token exchange and publishing remain outside Access. The Worker verifies the Access JWT signature,
issuer, audience and expiry before presenting OAuth consent. `ACCESS_ISSUER` and `ACCESS_AUD` must
match the Access application. Consent is required on each authorization. The canonical OAuth resource
and hosted connector URL is `https://YOUR-HUB.workers.dev/mcp`; the old root-level
REST read paths return 404. The bundled clients use the new paths.

**Authentication, and what would be simpler.** The Worker runs its own OAuth server (`workers-oauth-provider`, KV
grants, our consent page) with Access only in front of `/authorize`. Cloudflare Access can instead be the OAuth
server itself ("Managed OAuth" on an Access application): clients get a 401 with discovery metadata, register,
sign in through Access, and every `/mcp` request arrives with a `Cf-Access-Jwt-Assertion` the Worker already knows
how to verify (`src/access.mjs`). That would remove the OAuth library, the KV namespace and the consent page. Not
switched yet; open questions to test on a second Worker first: workers.dev support, ChatGPT/Claude/Dots client
compatibility (needs RFC 8707 resource indicators; CIMD isn't documented), keeping `/v1/snapshots` and `/health`
outside the Access application, and whether the per-tool split (read vs. app-only decide) the relay phase needs still
fits. vm's MCP Portal pattern fits managed backends with a fixed tool list, less a Worker of our own.

Tests: `npm test`. Deploy: `cf deploy` (check with `cf deploy --dry-run` first).
