# Agents Hub WebSocket design — 2026-10-09

Status: implemented and tested. Deployment and acceptance evidence are recorded separately.

## Architecture and boundaries

ChatGPT/Dot → Access OAuth → Worker MCP → SQLite Durable Object AgentRelay ← outbound WebSocket ← foreground Mac Terminal.
D1 snapshots remain the offline fallback. The current App identity, tools, schemas and dashboard remain.
No launchd/login service, automatic polling fallback or additional allowed agents. Local shell-free execution,
sandbox/remote guard, off switch, request journal, confirmation codes and redaction remain authoritative.
Hibernation avoids idle duration charges; requests, storage and snapshot traffic are not cost-free.

## Identity and durability

Logical identity is request_id + operation + canonical semantic arguments. Version-2 SHA-256 fingerprints sort
object keys recursively, preserve array order/values, and exclude request_id and confirmation credentials.
Transport attempt IDs, socket/process sessions and expiry are separate. Explicit retries have a fresh 20-second
attempt; concurrent duplicates share a pending attempt. This is a command deadline, not an agent lifetime.
start_run promptly returns run_id; later calls retrieve its output.

Legacy receipts verify their original JSON.stringify hash first, then atomically add the canonical fingerprint.
Without the original argument ordering, an unupgraded legacy hash cannot safely be reconstructed: fail closed.
Never discard an old claim. Both bridge and WebSocket clients read both formats.

At-most-once mutation execution holds per stable request identity while the authoritative local journal remains
intact. It is neither exactly-once delivery nor guaranteed completion. Durable dispatch precedes sending;
durable completion precedes acknowledgement. Late results do not need an in-memory waiter. Validate against
retained dispatch records and session/socket fencing. Transport ambiguity, interrupted local claims and terminal
results are distinct; only actual terminal results are cached as completed.

Retain cloud request/attempt records until five minutes after the first attempt deadline. Retries do not extend
that record's anchor. The local journal remains authoritative after cloud eviction. Do not durably store args.
Use the single DO alarm for the earliest expiry; cleanup is idempotent and stops when no records remain.

## Sessions and protocol

GET /relay/connect requires the existing machine bearer token in an Authorization header. Authenticate and
validate the versioned ownership/status handshake before evicting any healthy connection. The handshake is
carried in x-relay-hello so rejection happens before upgrade. Server hello acknowledges the socket identity.

Each process has one random session ID and sends acquire at most once. Ordinary reconnects send resume, accepted
only for the durable current owner. A superseded session stops even if it missed the replacement close frame.
Lost acquisition acknowledgement is recovered by resume of the same session, never automatic reacquisition.
A fresh manual process start can acquire. Each socket receives a new ID; fence every message by both identities.

Version 1 messages: server hello/request/ack; Mac status/result. Request fields retain id, operation, args, expires,
plus attempt/session/socket. Results distinguish terminal, interrupted, and rejected errors.

Constants: 10s HTTP/hello handshake; 20s attempt; 32 outstanding operations; 262144 UTF-8 bytes per complete message;
230000 bytes per serialized result; 10s Mac keepalive; 30s freshness; jittered exponential reconnect 1–30s.
ws explicitly disables redirects and compression and sets handshakeTimeout/maxPayload. Bound full messages, not
character counts. Serialize commands on the Mac; expiry is checked again before executing a queued command.

Mac timer → static ping → setWebSocketAutoResponse. Hosted freshness uses getWebSocketAutoResponseTimestamp on
demand. No DO heartbeat timer or D1 heartbeat writes. Attachments restore socket state after hibernation; only
active command waiters use timers. Snapshot publication stays independent and runs every minute. Local config
changes send status updates; every command rereads config. Ctrl-C closes the socket, cancels timers and drops
unstarted commands; already started agents may finish.

## Bridge rollout and recovery

1. Deploy/verify a polling bridge containing the DO class/binding plus compatible local journal handling. Record
   the deployed version, matching polling-client commit and configuration. Keep the D1 cleanup trigger.
2. Deploy the WebSocket transport without another DO lifecycle change. Stop admission, drain/classify commands,
   stop the visible polling client, and start the visible WebSocket client. Verify hosted helper execution.
3. Remove active polling routes/queries and cron; keep migration 0002 and empty obsolete table schemas.
   Explicitly synchronize schedules: cf beta.13 leaves old cron schedules when configured with an empty list.
   Retain a no-op scheduled handler to absorb delayed old deliveries during Cloudflare propagation.

Rollback must target the bridge, not a pre-DO version: Cloudflare blocks rollback across DO lifecycle changes.
Resource data is not rolled back. Restore matching polling client and explicitly verify/reinstate cleanup cron.
Rehearse the actual cf commands on an isolated Worker. If rollback is unavailable, forward-deploy bridge logic
with unchanged DO declarations. Never replay ambiguous mutations automatically. Preserve local journal data.

## Acceptance

Real Workers-runtime coverage: storage ordering; late results after timeout; fresh retry deadlines; canonical and
legacy receipts; conflicts; interrupted claims; restart/hibernation; ownership replacement including lost close;
invalid clients cannot evict; duplicate alarms; saturation; UTF-8 limits; handshake timeout/redirect rejection.
Local client tests cover serialized commands, acknowledgements, backoff, Ctrl-C, configuration refresh and expiry.
Run existing suites, a hosted helper test and inspect its local receipt. Do not resend the user's pending Dot test.
Rehearse WebSocket → bridge → WebSocket including cleanup triggers. Idle measurements exclude intentional minute
snapshots: target zero relay polling and D1 heartbeat writes, not zero Worker requests.

References: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
