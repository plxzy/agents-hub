# dok-dev development environment

`pi-release.sh` runs as `vscode` inside dok-dev. `prepare 1.1.0` installs a pinned
candidate with npm lifecycle scripts disabled and records registry integrity and
the resolved dependency lock. `activate 1.1.0` atomically changes only the Pi
launcher symlink. Existing processes, authentication and session files are untouched.

Rollback: read the selected private `tool-releases/rollback/pi-*.target`, create
a temporary symlink to that absolute target, then atomically replace
`~/.local/bin/pi`. Keep both release directories; do not uninstall the old package.

The container image and persistent user tooling are separate rollback units.
Candidate images must use isolated writable state. A production relay must never
be started as part of candidate verification.

## Direct development on dok-dev

Connect with `ssh dok-dev`, then:

```sh
cd ~/Development/dev-workflow
agent chat workflow
# Continue that conversation later:
agent chat workflow --continue
```

`pi` also remains available directly. `agent` uses reviewed definitions and memory
from a separate release, plus a committed runtime outside the project checkout.
The current private Git remote is `/home/vscode/repos/dev-workflow.git`; local
Mac changes reach it only through an explicit `git push dok main:main`.
Remote development results use review branches and are never merged automatically.

Operator installation accepts an optional revision as its third argument:
`bash tools/dok-dev/install-workflow.sh REPO KNOWLEDGE_RELEASE REVISION`.
This activates a new direct launcher; it does not reload the managed supervisor.

## Chat-approved development sessions

The hosted Agents Hub has a **Development** tab for the `workflow` agent on dok-dev.
Request a session, inspect its project/revisions/expiry, then click **Approve this
session**. Tasks and idle follow-ups reuse the same independent clone and Pi
conversation. Each task has a separate receipt. A busy host rejects new tasks.

The grant lasts at most four hours from the request. Execution also needs a
60-second lease renewed every 20 seconds. Revocation is durable while dok is
offline; the panel distinguishes recording it from confirming that work stopped.
Expiry preserves the conversation and files. Continuing requires a new grant.
An operator runtime upgrade requires explicit conversation migration.

Tools run in separate Linux namespaces with an empty `/proc`, isolated network
and private temporary home. Local HTTP fixtures work inside one tool invocation.
Project context still goes to the selected model provider. The installed SDK,
resource loader, tools, reviewed knowledge and permission definition stay outside
the writable clone. Checked-out extensions, MCP configuration and settings are
not loaded into the credential-owning process.

The container enforces 2 CPUs, 3 GiB memory and 512 PIDs across its workloads.
Session disk use is checked every five seconds against 4 GiB, with a 20 GiB
host free-space watermark; this is reactive accounting, not a filesystem quota.
Tasks have a 30-minute deadline. Individual tools have a 10-minute deadline and
1 MiB result cap. Export bundles are limited to 64 MiB and go through private
quarantine into append-only review refs. Export records the task's commit.

## Managed service and rollback

`dok-agent.service.in` is installed on **dok**, with `@RELEASE@` replaced by the
fixed runtime path inside dok-dev. The host user manager has lingering enabled.
The service starts and stops the specific in-container supervisor; killing only
the outer `docker exec` client is insufficient. A kernel parent-death signal
also terminates the Pi child if its supervisor disappears.

Use `systemctl --user status dok-agent` and `journalctl --user -u dok-agent` on
dok. The Mac relay remains a manually started foreground process.

Emergency remote-write disable: deploy the Hub with
`HUB_DEVELOPMENT_ENABLED=false cf deploy`; execution stops after lease expiry.
Stop the dok service for immediate local shutdown. Existing grant decisions stay
in the Hub's Durable Object. Restarting the supervisor invalidates its grants.
Rollback the service by restoring the previous fixed release/config and unit;
it will require new approvals. Never run two supervisors against production state.
Container and persistent Pi rollback remain the separate procedures above.
