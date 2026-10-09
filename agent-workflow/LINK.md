# One Agents Hub entry: the Mac relay

The hosted OAuth App owns the navigation and conversation-panel entrypoints. Local MCP remains usable in
Claude Code, Codex, Pi and standalone `agent ui`, but no longer advertises a second navigation item.

## Design and boundaries

- The Mac makes outbound HTTPS polls to the existing Worker; no inbound port, tunnel or public local server.
- Cloudflare Access Managed OAuth still authenticates App/MCP callers. A separate machine credential authenticates
  only `/relay/poll` and `/relay/complete`; it cannot authenticate `/mcp` or publish snapshots.
- A small D1 queue holds short-lived requests/results. Queue depth is bounded, unclaimed requests expire after
  20 seconds, and a timed-out caller cancels unclaimed work. Claimed work is never automatically requeued.
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
  D1 request/result payloads are cleaned five minutes after expiry by the Worker's minutely schedule; scheduled
  delivery can lag. Polling: immediately after a job, every 1 s for 30 s, then every 3 s; the heartbeat row is
  rewritten only on change or every 5 s. Local run receipts and mutation-journal records remain on the Mac.
- Offline hub access falls back to the sanitized snapshot with no Run/Review controls. While linked, snapshots
  publish every minute as well as after runs. Turning remote starts off does not terminate an already-started run
  or disable read/review access; stop the link to disconnect all live access.

## Operation

Private config: `~/.config/agent-readonly/link.json` (0600), containing `endpoint`, a separate `token`, `enabled`
and `agents`. Never put it in git or print it. The Worker secret is `RELAY_TOKEN`; publisher credentials are
separate. Apply `agent-readonly-service/migrations/0002_relay.sql` before enabling the relay.

```
agent link status      # safe: no credentials printed
agent link serve       # foreground; Ctrl-C disconnects
agent link off         # reject new remote starts on the Mac
agent link on          # re-enable starts for the existing allowlist
```

Run `agent link serve` in a visible Terminal window. The user chose foreground-only operation: no launchd service, login item, or detached relay. Closing the terminal disconnects live access; private config and receipts remain on the Mac.

After updating the Worker, refresh tools on the existing Agents Hub account App, then reopen the panel.
Reconnect/reload local MCP hosts to drop their cached extra navigation entry. No App recreation or plugin
uninstall is required.

## Verification

`node --test agent-workflow/ agent-readonly-service/test/` covers the Mac allowlist, off switch, deadlines,
credential sandbox profile, protocol schemas, atomic queue claims, result replay, conflicting IDs, interrupted
mutations, app-only visibility, and the existing agent/Worker tests. D1 queue tests execute actual SQLite SQL.
Deployment uses the existing `cf deploy` workflow. Do not claim a live relay or real remote run works
from unit tests alone; verify foreground process status and a hosted-client receipt separately.
