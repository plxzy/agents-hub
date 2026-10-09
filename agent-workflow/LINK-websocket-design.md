# Design proposal (not built): the relay over a WebSocket to a Durable Object

Status: draft for the user's review, 2026-10-09. Nothing here is implemented.

## Why

The current relay is a D1 queue the Mac polls. It works, but every request waits for the next poll (0–3 s), each
poll is a Worker request, and the queue needs expiry, cleanup and a heartbeat table. Cloudflare's supported shape for
"a client that stays connected" is a WebSocket to a Durable Object (DO) with hibernation: the connection costs
nothing while idle, and the DO can push a request the moment it arrives.

## Shape

```
ChatGPT / Dot / claude.ai ──OAuth (Access)──▶ Worker /mcp ──▶ Durable Object "relay" ──WebSocket──▶ agent link serve (Mac)
                                                    │                                    (outbound, foreground Terminal)
                                                    └─ D1 snapshots (unchanged, offline fallback)
```

- `agent link serve` opens one outbound WebSocket to `/relay/connect` with the separate relay token (unchanged
  credential split). One connection at a time; a new one replaces the old.
- The Worker forwards each relay tool call to the DO, which sends `{id, operation, args, deadline}` over the socket
  and awaits `{id, result}` (deadline 20 s). "Mac online" = a socket is connected; no heartbeat table.
- Everything the Mac enforces stays the same and stays on the Mac: allowlist, off switch, shell-free remote agents,
  remote guard, request-id journal (at-most-once), confirmation codes, redaction, size limits.
- The DO keeps nothing durable except, optionally, the last few results for request-id replay (in DO storage, with
  an alarm to delete them after 5 min) — replacing the D1 `relay_jobs` table and the cron.

## What it removes / adds

- Removes: `relay_jobs`, `relay_status`, migration 0002, the minutely cron, poll loop and backoff.
- Adds: one DO class (~80 lines), a WebSocket client in `link.mjs` with reconnect (exponential backoff, capped).
- Unchanged: OAuth, tools and schemas (`relay-contract.mjs`), dashboard, snapshot publishing.

## Open questions for the user

1. Is the extra Cloudflare piece (a Durable Object) acceptable? DOs with WebSocket hibernation are on the free plan.
2. Keep D1 as a fallback transport, or remove it once the DO version is verified?
3. Same foreground-only rule (`agent link serve` in a visible Terminal) — assumed yes.

## Verification plan

Unit tests with a fake socket; a live test: start a `helper` run from the hosted panel, kill and restart
`agent link serve` mid-request (expect "may have completed; retry with the same request_id" and a journal replay),
and check Worker request counts for an idle hour.
