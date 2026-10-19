# agents runner on dok

The always-on runner for Agents Hub: one small container (`agents`, user `agent`) whose main process is the
agent-workflow supervisor (`dev-supervisor.mjs`). Docker restarts it; there is no systemd unit and no `docker exec`
wrapper. It replaces the supervisor that ran inside the vm project's `dok-dev` devcontainer (user `vscode`); the
cutover happened on 2026-10-12 17:01 UTC. The old `dok-agent` unit is disabled and retained only for rollback;
the old `dok-dev` container and Codex image were removed on 2026-10-12. Its named volumes remain preserved.

The image selected by Compose is `agents-runner:pi-1.3.0-node-26.12.0-20261017`, based on the digest-pinned Node 26.12.0 Debian 13 Trixie slim
image. It contains npm 12.2.0, Pi 1.3.0 (from the lockfile), bubblewrap, Git, Python 3, procps, mawk, CA certificates
and tini. It has no standalone `codex` executable, SSH daemon or editor. The image strips Pi's unused OpenAI Codex
provider and OAuth/API modules; the ordinary OpenAI provider remains.

Two Pythons live in the image. The one agents get is a pinned CPython **3.14.8**, compiled from the
checksum-verified python.org source tarball and installed under `/opt/python`; it serves **every** agent-visible
`python3`, including suites that reset `PATH` to `/usr/bin:/bin`: the image diverts Debian's `python3` binary to
`/usr/bin/python3.debian` and points `/usr/bin/python3` into `/opt/python`, so the pinned build wins ahead of
`/usr/local/bin` either way a stripped PATH is ordered. Debian's python3.13 remains only at
`/usr/bin/python3.debian` for the runner's internals (`parent-exec.py`, the installer's JSON step) that must keep
running on the interpreter the base image manages, independent of the pinned build. The sandbox PATH still starts
with `/home/agent/.local/bin:/usr/local/bin`. `ffmpeg`/`ffprobe` come from Debian's `ffmpeg` package; on the
Trixie base image that resolves to `7.1.5-0+deb13u1`, the exact same package byte-for-byte as in tikkytracker's
devcontainer Debian 13 Trixie image. The runner does not compile a pinned ffmpeg. The accompanying codec
libraries resolve through Debian's `/etc/alternatives` symlink tree, so the sandbox policy mounts `/usr/lib` and
`/etc/alternatives` read-only alongside `/usr`. Because bubblewrap runs with an empty root, the tool sandbox
itself pins a frozen synthetic `sandbox` passwd/group entry (kept in the frozen tool release next to
`linux-worker.mjs`) onto `/etc/passwd` instead of exposing host `/etc/passwd`: bwrap maps the invoking uid into
its user namespace unchanged, so the entry names uid 1000 (dok's `agent` user) and uid 0 (host acceptance
containers) identically, records a home directory, and lets
`pwd.getpwuid`, `os.path.expanduser('~')` and `getpass.getuser()` answer even when a suite strips `HOME`. A
writable run also restores hashed Python requirements the same way it restores npm lockfiles: before the agent
starts, the supervisor downloads every pinned artifact from PyPI for each `python-requirements.txt` /
`requirements.txt` / `requirements-dev.txt` (repository root, `.devcontainer` and other directories up to two
levels deep), verifies the bytes against every `--hash` in the file, caches them by requirements hash, and the
no-network sandbox installs them with `python3 -m pip install --no-index --require-hashes` into
`<dir>/.deps-python` (kept out of the review commit via `.git/info/exclude`). The sandbox policy points `PYTHONPATH`
at every restored `.deps-python` near the repository root, so `python3 -m yt_dlp --version` and test suites import
the pinned wheels with no per-repo wiring; the outcome shows on the run's dependency restore section next to the
npm results, with skipped files carrying a path-free reason (unpinned lines, missing hashes, non-PyPI sources all
skip rather than fail the run).

The **node** binary in the sandbox is the runner's own Node (`26.12.0`, the pinned base image), independent of
any one repository's toolchain. tikkytracker's devcontainer pins Node `26.10.0` exactly, but its `package.json`
accepts any `>=26.10.0 <27`; the runner does not swap in a repo-specific version, since Node 26.12.0 satisfies
that range and keeping the runner's interpreter neutral matters more than matching one project's exact pin.

Private Pi extensions are not part of this repo. Compose passes the folder named by `AGENTS_EXTENSIONS` (in
`~/agents-runner/.env`; default the empty `./extensions`) as the `extensions` build context, and the image copies it to
`/opt/pi-extensions/`. An accounts module there that exports `accountProvider(slot, name, catalog)` adds extra provider
logins: name it as `accounts_module` in the runner config and list the slots in `limits.slots` (default: one slot,
`openai`).

| What | Where (inside the `agents-home` volume) |
|---|---|
| Pi login (your own `/login`, never copied) | `~/.pi/agent/auth.json` |
| Supervisor config (endpoint, machine token, paths; mode 600) | `~/.config/agent-workflow/dok.json` |
| Supervisor health heartbeat (private, Docker-read) | `~/.local/state/dok-agent/supervisor-health.json` |
| Released code (`install-workflow.sh`) | `~/.local/share/agent-workflow/releases/<rev>`, launchers in `~/.local/bin` |
| Reviewed knowledge / dated context | `~/.local/share/agent-workflow/{knowledge,context}/` |
| Bare repo (`main` + append-only review refs) | `~/repos/dev-workflow.git` |
| Runs, sessions, receipts | `~/.local/state/dok-agent/` |

Files here are copied to `dok:~/agents-runner/`. Pi is pinned by `pi/package-lock.json`; the base image by digest.

```sh
# on dok
cd ~/agents-runner && docker compose build
docker compose up -d                     # start / restart the supervisor
docker logs -f agents                    # "dok-dev linked to Agents Hub."
docker inspect --format '{{.State.Health.Status}}' agents
# from the Mac
ssh -t dok docker exec -it agents pi     # interactive Pi (e.g. /login); paste the redirect URL when asked
ssh -t dok docker exec -it agents agent chat workflow
git push dok main:main                   # remote "dok" uses docker exec git-receive-pack (see below)
```

Mac remote: `git remote set-url dok dok:/home/agent/repos/dev-workflow.git` with
`remote.dok.receivepack = docker exec -i agents git-receive-pack` and
`remote.dok.uploadpack = docker exec -i agents git-upload-pack`.

Upgrade: `install.sh <revision>` fetches the public repository (`AGENTS_SOURCE` in `.env`, default GitHub `plxzy/agents-hub`) into
the bare mirror `~/repos/agents-hub.git` in the home volume, archives that commit, installs it and restarts the container.
Rollback: `install.sh <previous revision>`. Never run a second supervisor against the same Hub owner: starting one
replaces the other's connection.

Docker health is supervisor-based: the supervisor writes a private heartbeat only after the Hub WebSocket handshake
and each authenticated pong. The check also verifies the recorded supervisor PID and Linux process start time, the
release process identity, and a 30-second heartbeat age. A live Node process with a stale or disconnected Hub link is
therefore unhealthy; a stale file from an earlier supervisor cannot pass the identity checks. Docker reports the state
but the restart policy does not restart solely because a healthcheck fails.

### Candidate test utilities (2026-10-13)

The image recipe includes `procps` (`ps`) and `mawk`. `/usr/local/bin/awk` points directly to
`/usr/bin/mawk`: Debian's `/usr/bin/awk` normally goes through `/etc/alternatives`, which is outside
the tool sandbox. Installing `mawk` alone therefore does not make `awk` usable there.

The tool sandbox mounts fresh procfs with `--proc /proc` inside its existing isolated PID namespace.
It never bind-mounts the runner's or dok host's `/proc`. Linux acceptance checks verify process listing,
awk execution, exclusion of an outside process, and refusal to reach an outside file through procfs.
Docker's default masked proc paths prevent this nested mount. The matching Compose recipe uses
`systempaths=unconfined`, which removes Docker's default path masks in the outer runner container;
capabilities remain dropped and `no-new-privileges`, seccomp, and the tool's namespaces/mount isolation
remain enabled. This is a runtime configuration change, not just a package installation. Do not roll out
the new sandbox release without the matching image and Compose settings: the old settings reject its
procfs mount. No host PID namespace, privileged mode, Docker socket, or host-root mount is required.
Run these checks in a separate candidate container without the `agents-home` volume or a Hub connection.
Promoting a candidate image and its matching sandbox release is a separate rollout; changing the image
recipe alone does not update a running container.

## Runtime refresh (2026-10-17)

Pi and its SDK packages are pinned together at 1.3.0; the Linux tool policy requires that same version.
Node 26.12.0 uses the multi-platform image digest above, and npm is pinned separately at 12.2.0.
Rebuild with `docker compose build --pull --no-cache` to refresh Debian packages as well as npm dependencies.
The supervisor's lockfile already resolves the current WebSocket dependency (ws 8.22.0).
The review publisher uses the same Node base image.

Candidate validation: repository suites passed on Node 26.12.0 (208 application tests and 54 Hub tests;
three platform-specific skips). A separate Linux container passed 198 workflow/publisher tests,
including real Pi sandbox isolation and killed-tool recovery (one platform-specific skip), with no
production volumes, credentials or Hub connection. Pi's npm audit reported zero known vulnerabilities.
A live read-only helper run confirmed Pi 1.3.0, completed inference and successfully listed the repository root.
Drain and back up before promotion; preserve the previous images, configuration, sessions and releases for rollback.

## Restart recovery (2026-10-13)

One-shot runs persist private checkpoints under `state/recovery-v1/<run>/` before executing tools.
The Pi child is the only checkpoint writer; the supervisor reads after the child stops. Completed tool
results are reused by tool-call identity. A started mutating tool is never replayed: the runner performs
one read-only inspection and the Hub requires **Approve continuation from current files** before writes.
Each continuation has a new run ID linked to its predecessor. Original interrupted receipts remain intact.
Checkpoints and tool results are private (mode 600), bounded to 16 MiB total / 2 MiB per result; only bounded
recovery metadata reaches the Hub. Execution budgets carry across attempts. Final receipts are durable
before cleanup, and unfinished work is excluded from pruning.

`limits.autoRecovery: true` enables up to two automatic safe attempts per chain. Revision changes,
missing/invalid checkpoints, changed agent/knowledge, missing workspaces, or exhausted budgets pause recovery.
A crash during preparation before the setup record exists requires operator inspection; it does not re-clone
over retained files. Account unavailability is shown and retried without creating a new run. Completed
model results can finish export without another model call. This does not promise exactly-once arbitrary
shell effects: uncertain commands require inspection and approval.

`install.sh` drains admission and refuses to restart while active work remains. The initial migration from
releases without `control.sock` requires a backed-up, verified-idle operator cutover. Subsequent upgrades and
rollbacks use the current installer (including when installing an older release); never run two supervisors.
Keep `e4e9acf` as the preservation-capable rollback baseline. Recovery journals are release-bound; rollback
preserves them but does not automatically resume newer checkpoints.

The hosted form saves request identity before admission. Model callers must choose and retain `request_id`
before `start_run`. After a caller-side permission-review timeout, use `get_start_status` with that identity.
An unknown result does not establish that no run exists. If the caller allows one retry, reuse the exact
request and identity; changing the model is a different request. A second timeout requires user guidance.

Completed write runs publish a private, immutable Git bundle to the Hub unless `runArtifacts` is set to `false` in `dok.json`.
The receipt exposes bounded artifact identity metadata only. A linked Mac can import a bundle with
`node tools/run-artifact/import.mjs RUN_ID REPO_NAME LOCAL_CHECKOUT`; the importer verifies the checksum, recorded
base/head and ancestry before creating `refs/remotes/hub-review/runs/<run_id>`. It never checks out, merges or pushes.

Historical pre-checkpoint runs can be reconciled with the operator-only script below. It reads the last
assistant text within the run's recorded time window, checks the matching review ref and retained head, and
requires ancestry from the original base. Recovered text is explicitly partial/unverified, and status stays
interrupted. It backs up each original receipt before applying and never executes project code or moves refs.

```sh
node tools/dok-runner/reconcile-interrupted.mjs PRIVATE_CONFIG RUN_ID...
node tools/dok-runner/reconcile-interrupted.mjs PRIVATE_CONFIG RUN_ID... --apply
```

Validation: `node --test agent-workflow/`, `cd agent-readonly-service && npm test`.
On the actual Linux runner, copy source into an isolated directory and run the recovery, worker, supervisor
completion and sandbox tests with `AGENT_TEST_LINUX=1`; use temporary state, never the production supervisor
configuration. Tests must verify partial-write refusal, approved continuation without command replay,
linked-intent reconstruction, retained artifacts, and saved-result reuse.

### Continuity rollout (2026-10-14)

The continuation/recovery update accepts eligible failed model turns without relabelling the original receipt. Only new
failures stamped by the updated supervisor participate in automatic failed-turn recovery. Do not bulk-convert old failed
receipts or resume superseded work during deployment. Preserve all checkpoints and their release bindings. Drain and
back up before installing; validate in isolated Linux state with no production configuration or second Hub connection.
A missing review ref or mismatched saved head refuses before cloning. No-edit review continuations keep `source_review`
and remain continuable; unresolved attempts in the same conversation block workspace replacement.

During a mixed-version rollout the Hub only offers failed-turn recovery after the runner has published
`recovery.failed_resume_supported: true`. Older ready receipts keep their evidence but do not advertise an action
that the old supervisor would reject. Interrupted-run recovery remains compatible.

## GitHub review publication (2026-10-14)

The separate [review publisher](../review-publisher/README.md) automatically exports enabled repository reviews as draft PRs and supplies fresh GitHub bases for independent runs. Pi receives no GitHub credential. Published follow-ups fetch the current PR head (including reviewer fixes) and update the same PR. Historical run snapshots remain immutable. Hub migrations 0008 and 0009, a dedicated publisher secret, an explicit repository activation cutoff and the runner socket configuration are required. `publish_review` retries publication without rerunning the agent.
