# GitHub review publisher

The always-on dok publisher turns completed VM and TikkyTracker review bundles into
GitHub draft PRs. Pi has no GitHub credential. The publisher has only the two mapped
bare repositories, a private GitHub App key, a dedicated Hub credential and its own
state/socket volumes. dev-workflow remains internal.

A completed changed receipt and its verified R2 bundle queue one immutable job.
Publication verifies checksum, Git objects, exact head and base ancestry before
pushing `review/agents/<conversation-root>`. Retries reconcile the existing branch
and PR. Follow-ups fast-forward that branch without replacing human PR edits.
Unexpected branch changes or a closed PR needing another commit block publication.
A blocked job also holds later jobs in its conversation. `publish_review {run_id}`
retries/backfills the saved artifact without running Pi again. No merge is performed.

Independent runs ask the publisher to fetch GitHub main into an immutable per-run
ref before checkout. Failure stops setup; it cannot silently use stale main.
Continuations and interrupted-run recovery retain their original saved commits.
The receipt records the fetched commit and observation time. Publication of an
older saved result does not establish acceptance against today's main.

## Install

Create a private owner-only GitHub App, disable webhooks and install only on the
allowed repositories. Permissions: Contents, Pull requests and Workflows write;
Metadata read. Tokens are short-lived and requested for one repository at a time;
base-fetch tokens have only Contents read. Store the PEM and publisher.json outside
this repository, mode 600, in a mode-700 directory owned by UID 1000 on dok.

Configuration (replace placeholders; never commit real credentials):

```json
{
  "endpoint": "https://YOUR-HUB.workers.dev",
  "token": "DEDICATED-HUB-PUBLISHER-SECRET",
  "state": "/state",
  "socket": "/control/publisher.sock",
  "github": { "app_id": 0, "installation_id": 0, "private_key_file": "/config/github-app.pem" },
  "repositories": {
    "vm": { "github": "OWNER/vm", "base": "main", "repository": "/repos/vm.git" },
    "tikkytracker": { "github": "OWNER/tikkytracker", "base": "main", "repository": "/repos/tikkytracker.git" }
  }
}
```

1. Apply Hub migration `0008_review_publications.sql`, set matching
   `REVIEW_PUBLISHER_TOKEN`, deploy Hub. Existing Mac and dok credentials are separate.
2. Create external volumes `agents-review-state`, `agents-review-control` and
   `agents-review-config`, owned by container UID 1000. Copy the private configuration
   and PEM into the config volume, mode 600 (directory 700). Rootless Docker maps
   host and container UIDs differently; do not relax file permissions to compensate.
   Build from the repository root with this directory's Dockerfile.
3. Run this directory's Compose project. It mounts configuration read-only and uses
   volume subpaths of existing `agents-home`.
4. Add `reviewPublisher: {socket: "/run/agents-review/publisher.sock",
   repositories: ["vm", "tikkytracker"]}` to the private runner config. Install the
   committed workflow revision using the runner's draining installer and updated
   Compose file. Never start a second supervisor.
5. Insert exact mappings into `review_repositories` with `enabled_after` set to the
   activation time. Historical jobs are excluded unless explicitly backfilled.

The dashboard shows publisher liveness, publication state, retry action and PR link.
Health is stale after 60 seconds without Hub contact. Logs contain run ID/status;
Git diagnostics and credential values are never returned. Leases renew every 15
seconds, expire after five minutes, and serialize unfinished jobs per conversation.
Transient failures retry with capped backoff; permissions/conflicts require repair.

## Verify and rollback

Run `node --test tools/review-publisher/publisher.test.mjs` and the Hub/workflow suites.
Verify real GitHub PR head equals the saved receipt; check draft status separately
from CI success. Stop/restart the publisher to test durable retry. A healthy
container alone does not establish end-to-end publication.

Rollback: drain the runner before restoring its previous release/config/Compose;
stop this Compose project and remove the trusted repository rows to stop automatic
queueing. Retain queue tables, R2 bundles, state volumes and GitHub branches/PRs for
recovery. Never delete review work to roll back a service. Restoring an older runner
also restores its earlier base-selection behavior.
