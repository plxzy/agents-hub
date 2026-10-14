# Runners: where agents run, and how the Hub reaches them

(Replaces `LINK.md`, the Mac relay design, archived in `../archive/2026-10-12-mac-relay/`.)

## Today (2026-10-13)

- **dok runs hosted starts.** The `agents` container on dok (`../tools/dok-runner/`) connects one outbound WebSocket to the Hub's
  `AgentRelay` Durable Object (`owner-dok-dev`, `/relay/dok-dev/connect`, secret `DOK_RELAY_TOKEN`). The Hub's `start_run`
  dispatches `run_start` to it; receipts, account cooldowns, memory bundles and agent bundles use the same token on
  `/relay/dok-dev/*`. Read-only agents get a read-only clone, agents with write tools a writable no-network clone that comes
  back as a review branch (`git fetch dok`). See `README.md` "Remote runs on dok".
- **The Mac is a client, not a runner for hosted callers.** It posts receipts and reads memory with its own token
  (`~/.config/agent-readonly/mac.json`, secret `MAC_TOKEN`, routes `/relay/mac/*`); it never connects a socket and nothing in
  the Hub can start work on it. `agent run|chat` and legacy local MCP start operations still run on the Mac. Updated local panels default to dok via `start_selected_run`; explicit `runner: mac` stays local, with no automatic fallback. The Mac token may request existing allowed dok runs on `/relay/mac/start`, with read-only recovery on `/relay/mac/starts/:id`. `agent sync pull|push` mirrors
  decisions and definitions (see `README.md`).
- **The Hub holds the state:** runs, ratings, memory notes, published agent definitions (D1). Decisions are the user's clicks
  in the Hub panel; every decision needs a one-time code that only the panel receives.

## Retired

`agent link serve|on|off|doctor`, the `owner-mac` relay and `/relay/connect`, the `RELAY_TOKEN` secret, Mac-run remote starts
(helper-only allowlist), the snapshot publisher and `PUBLISH_TOKEN`. Local private files that belonged to them
(`~/.config/agent-readonly/link.json`, `link.log`, `relay-journal/`) are no longer read by anything.
The Durable Object class is unchanged (it still serves dok); the `owner-mac` instance is empty and inert.

## Rollback

The last commit with the Mac relay is `c91c008`, the Worker version deployed from it (secrets
`RELAY_TOKEN` and `PUBLISH_TOKEN` were deleted afterwards: recreate `RELAY_TOKEN` and `~/.config/agent-readonly/link.json` before
using `agent link serve` from that commit). Never roll back across the Durable Object lifecycle change recorded in
`../archive/2026-10-12-mac-relay/LINK.md`.

## Later

A Cloudflare Containers runner (same image as dok) would connect to the same Durable Object under another name; nothing in the
protocol is dok-specific except `owner-dok-dev`.
