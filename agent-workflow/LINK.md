# One Agents Hub entry: the Mac relay

The hosted OAuth App owns the navigation and conversation-panel entrypoints. Local MCP remains usable in
Claude Code, Codex, Pi and standalone `agent ui`, but no longer advertises a second navigation item.

## Design and boundaries

- The Mac makes one outbound WebSocket connection to the existing Worker; no inbound port, tunnel or public local server.
- Cloudflare Access Managed OAuth still authenticates App/MCP callers. A separate machine credential authenticates
  only `/relay/connect`; it cannot authenticate `/mcp` or publish snapshots.
- A SQLite-backed Durable Object routes commands immediately over the connection. Up to 32 commands may be
  outstanding; each transport attempt expires after 20 seconds. This is not the agent lifetime: start returns
  a run ID promptly, and fetching completion is a separate operation. Disconnected work is not automatically
  replayed. Explicit retries reuse the logical request ID with a fresh attempt deadline.
- The Mac validates every operation and its inputs. Its private config is authoritative for the remote-start
  allowlist and off switch. Only **helper and network** were authorized by the user. `workspace: here` is refused
  remotely until an explicit project-folder policy is designed.
- Starts use the existing operations catalog and launcher. Remote helpers always enter the existing macOS
  credential sandbox, even if normally unsandboxed locally. Their guards and reviewed memory still apply.
- **Only agents without a shell may start remotely** (tools limited to read, grep, find, ls; enforced on the Mac,
  2026-10-09 review). Remote runs also load `guards/remote.ts`: no shell, edit or write, and file tools must stay
  inside the agent's workspace (symlinks resolved) and away from secret-looking files. Reason: the macOS sandbox
  cannot hide Pi's own credentials from the agent (Pi needs them), and the read-only guard does not stop reading or
  uploading files, so a remote task (possibly from a prompt-injected Dot) could otherwise send them out. `network`
  was removed from the allowlist for this reason; a shell agent needs a stronger boundary before it can return.
- Mutations require a request ID. A private local journal is written before execution; a completed ID replays its
  result, a conflicting ID is rejected, and an interrupted ID is never executed again. This is at-most-once
  dispatch, not a guarantee of successful execution. On ambiguous failure, inspect the local run/review state.
- Models can start allowed agents and fetch the result of a relay-started run. `panel_data`, `panel_run`,
  `rate_run` and `review_decide` are MCP Apps **app-only** tools. In addition, `rate_run` and `review_decide` need
  a one-time `confirm` code per item that `panel_data` returns in the result's `_meta` (given to the widget, not
  the model); the Mac refuses decisions without an unused matching code, so they hold even if a host ignores
  app-only visibility. Codes live in the `agent link serve` process (30 min); restarting it voids them.
- Live panel reads include full run details and review content, with best-effort secret redaction and bounded
  output. Those details pass through the user's hosted hub/ChatGPT. Raw events and transcripts are excluded.
  Cloud request/dispatch/result records expire five minutes after the first attempt deadline; retries do not
  extend that retention. An idempotent DO alarm targets the earliest expiry, then stops when nothing remains.
  Request arguments are not durably stored. Local run receipts and mutation journals remain on the Mac.
- Version-2 journal fingerprints use canonical semantic arguments, independent of transport deadlines and
  confirmation credentials. Legacy receipts require their original argument ordering for the first replay;
  that verified match adds a canonical fingerprint without discarding the original hash or claim state.
- Each foreground process acquires ownership once. Reconnects resume that process session; a replaced session
  cannot reacquire automatically. If the Terminal reports a replaced/rejected session, restart manually.
- The Mac sends a static keepalive every 10 seconds. Cloudflare answers with setWebSocketAutoResponse without
  waking the DO; status uses its timestamp and a 30-second freshness window. There is no heartbeat table or
  cloud heartbeat timer. Hibernation avoids idle duration charges, not request/storage costs.
- Offline hub access falls back to the sanitized snapshot with no Run/Review controls. While linked, snapshots
  publish every minute as well as after runs. Turning remote starts off does not terminate an already-started run
  or disable read/review access; stop the link to disconnect all live access.

## Operation

Private config: `~/.config/agent-readonly/link.json` (0600), containing `endpoint`, a separate `token`, `enabled`
and `agents`. Never put it in git or print it. The Worker secret is `RELAY_TOKEN`; publisher credentials are
separate. Install local client dependencies with `npm ci --prefix agent-workflow`.
The historical D1 migration and empty relay tables remain for rollback; active transport uses the DO.

```
agent link status      # safe: no credentials printed
agent link serve       # foreground; Ctrl-C disconnects
agent link off         # reject new remote starts on the Mac
agent link on          # re-enable starts for the existing allowlist
```

Run `agent link serve` in a visible Terminal window. The user chose foreground-only operation: no launchd service, login item, or detached relay. Closing the terminal disconnects live access; private config and receipts remain on the Mac.

After updating the Worker, refresh the Agents Hub App **on chatgpt.com** (Settings → Apps → Agents Hub → Refresh), then reopen the panel. ChatGPT stores the App's tool list and panel page; restarting the desktop app does not update them (verified 2026-10-09: decisions failed with *Missing confirm* until the refresh).
Reconnect/reload local MCP hosts to drop their cached extra navigation entry. No App recreation or plugin
uninstall is required.

## Verification

`node --test agent-workflow/ agent-readonly-service/test/` covers the Mac allowlist, off switch, deadlines,
credential sandbox profile, protocol schemas, durable dispatch, result replay, conflicting IDs, interrupted
mutations, app-only visibility, and the existing agent/Worker tests. Runtime tests use Miniflare/workerd with real SQLite DO storage and WebSocket hibernation.
Deployment uses the existing `cf deploy` workflow. Do not claim a live relay or real remote run works
from unit tests alone; verify foreground process status and a hosted-client receipt separately.

Acceptance recorded on 2026-10-09: 94 tests passed, hosted UI helper execution succeeded, and the polling-bridge
rollback procedure was rehearsed. The user subsequently reported successful Dot execution and result retrieval
for `r-20261009T114827Z-b4e188` (“Dot relay works.”); a catalog-refresh interruption recovered on retry.
See `../evidence/2026-10-09-agents-hub-websocket/VERIFICATION.md` and
`../evidence/2026-10-09-agents-hub-dot-acceptance/REPORT.md` for provenance and measurement limits.

## Rollback

The compatible polling bridge is commit `fd94411`, deployed Worker version
`WORKER-VERSION-ID`. Never target a pre-DO version. Cloudflare rejects rollback across DO
lifecycle changes, and resource data/triggers do not roll back with code.

Stop new calls, drain/classify outstanding commands, then stop the visible client. Restore the bridge Worker
with `cf workers deployments create --worker agents-hub --strategy percentage --versions
'[{"version_id":"WORKER-VERSION-ID","percentage":100}]'` (one command). In an isolated checkout
of `fd94411`, run `cf workers triggers deploy` from `agent-readonly-service` to restore the minute cleanup.
Verify the schedule through `tools/cloudflare-cron/schedules.mjs`; this version-pinned helper also explicitly
removes the schedule on WebSocket cutover because cf beta.13 leaves existing schedules when the list is empty.
Run the matching bridge `agent.mjs link serve` in the visible Terminal, preserving private config and journal.
Verify the selected version is serving before starting the client; deployment propagation can reject a first
acquisition, requiring a fresh manual start. A forward deploy of bridge code must preserve the DO declaration.
A no-op scheduled handler absorbs delayed deliveries after schedule removal; it does not schedule work.
See `LINK-websocket-design.md` for protocol details and the dated evidence directory for rehearsal results.
