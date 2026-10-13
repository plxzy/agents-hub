# agent-workflow

Step 1–2 of the progressive agent plan (2026-10-09): plain Pi agents defined as files, with
layered memory that the user reviews. No Cloudflare, no registry, no control plane. It follows
the brief *dev-workflow-agent-context*: portable
knowledge first, one direct specialist, curated memory compared against a no-memory baseline.

`agent` is on PATH via `~/.local/bin/agent` (symlink to `agent.mjs`).

```sh
agent list
agent chat helper                                       # interactive Pi session as helper
agent chat helper --continue                            # resume its last session
agent run helper "where is the update-comparison tooling and what does it produce?"
agent run helper --continue "and how do I run it?"     # same Pi session
agent run helper --no-memory "..."                      # baseline without reviewed memory
agent runs                                              # receipts
agent memory                                            # candidates to review
agent memory accept <n|id> [--scope s] [--supersedes old-id]
agent memory reject <n|id> [reason]
agent memory add <scope> "text"                         # write a note yourself
node --test agent-workflow/                             # tests
```

## Improving over time (`improve.mjs`)

```
agent run → agent feedback <run|last> good|bad "why" → agent reflect <agent>
  → proposals (memory notes, test cases, instruction edits) → agent review [show|accept|reject]
  → agent eval <agent> (score vs. the previous version) → every accepted change is a git commit in ~/.agents
```

- **Test cases** live in `~/.agents/evals/<agent>/*.md`: a question plus `must_include` / `must_not_include`
  (case-insensitive regexes) and an optional `max_tools`. `agent eval` records each score with the agent's
  version hash and the memory it used, and prints the previous score next to it.
  Add patterns with repeatable flags, one per regex:
  `agent eval add helper --include 'a{1,3}' --include 'hello, world' --exclude 'wrong' --run 'git status' --not-run 'sudo' "Question"`.
  `--include`, `--exclude`, `--run`, and `--not-run` all repeat. For compatibility, a flag appearing
  only once splits its value on commas unless it contains `{`; repeated values are always kept intact.
  New cases store JSON arrays so regex commas survive saving and loading; old comma-list cases still work.
  Cases may also have an absolute `cwd:` path. For `workspace: here` agents, `agent eval add` saves
  the current folder; `--cwd /absolute/project/folder` overrides it. `agent eval` uses each case's saved
  folder, so it can be started from home. Legacy cases without `cwd` still use the folder eval was
  started from. Fixed-workspace agents ignore `cwd`, and adding their cases never writes it.
  The usual `here` restrictions apply at evaluation time (a directory strictly inside home).
- **The coach** (`agent reflect`) is a no-tools Pi call that sees the definition, reviewed memory, recent
  task runs with your ratings, and the latest test results. It may propose notes, new test cases, and at
  most one instruction rewrite; it may not add tools or permissions. Its input and output are kept in
  `~/.local/state/agent-workflow/reflections/`.
- **Versions:** `~/.agents` is a git repo for definitions, skills, reviewed memory, evals and proposals.
  Pending `memory/candidates/` is ignored and excluded from automatic commits (even if staged).
  `git -C ~/.agents log -p agents/helper.md` is the agent's history and `git revert` undoes a change.
  An instruction proposal is refused if the agent changed after the coach saw it.

## Layout (since 2026-10-09: definitions and memory in `~/.agents`, `AGENT_HOME`)

| Path | What | Owner |
|---|---|---|
| `~/.agents/agents/<name>.md` | Definition: frontmatter `tools` (comma list), `model`, `thinking`, `workspace`, `memory_scopes` + instructions. Same file format pi-subagents extensions read. | You |
| `~/.agents/memory/shared/`, `projects/<p>/`, `agents/<a>/` | Accepted memory, one fact per file | You |
| `~/.agents/memory/candidates/` | Proposed by agents in `agent run`; inactive until accepted | Agents propose, you decide |
| `~/.agents/memory/rejected/` | Rejected proposals, kept as evidence | |
| `~/.local/state/agent-workflow/` (`AGENT_WORKFLOW_STATE`) | Run receipts, raw Pi events, Pi sessions per agent | Private |

Agent file fields: `name`, `description`, `model`, `thinking`, `tools`, `workspace`, `memory_scopes`,
`skills`, `guard`, `sudo_allow`, `write_paths`, `here_write`, `protect_paths` (lists accept comma-separated values or `[a, b]`).
`workspace` accepts a fixed folder (`~/...` is expanded) or `here`. With `workspace: here`, `agent run`
and `agent chat` use the folder they are started from; `runAgent` accepts an optional `cwd`, defaulting to
`process.cwd()`, used only for `here` agents. The folder is symlink-resolved and must be a directory
strictly inside home, not home itself. By default it is added to `write_paths` for that invocation only.
With `here_write: AGENTS.md, CLAUDE.md, .agents, .claude, .codex`, only those paths relative to the
start folder are added instead: listed directories include their descendants, and listed files can be
created even if they do not exist yet. Absolute paths and paths that escape the folder via `..` are
rejected. An empty `here_write` adds no paths; omitting it preserves whole-folder write access.
`here_write` has no effect on fixed-workspace agents; explicit `write_paths` remain additional grants.
Either way, `workspace: here` enables the macOS sandbox even when no `write_paths` were specified.
`agent list` shows `here_write` when set. Receipts record the resolved folder.
Sessions include a stable short hash of that folder: `--continue` shares task/chat history in the same
project, never another project; symlink aliases share history. Fixed-workspace agents keep their existing
session paths and permissions.

`memory_scopes` is deliberately not called `memory`, which pi-subagents extensions use for their own
self-written memory. `agent chat` loads accepted notes but does not capture proposals; use
`agent memory add` for anything worth keeping from a chat.

## Memory layers

1. **Instructions:** the agent file, plus `AGENTS.md` that Pi loads from the workspace.
2. **Session:** Pi's own session; `--continue` resumes the agent's last one.
3. **Reviewed notes:** accepted items for the agent's scopes are added to its system prompt. Agents
   are read-only and propose notes as ```` ```remember ```` blocks; the launcher saves those as
   candidates. Only `agent memory accept` makes them active; `--supersedes` retires an older item.
4. **Retrieval:** not built. Add it when the notes outgrow the prompt.

`agent memory` shows a count and numbered candidates with their six-hex ID suffix, scope,
proposer, age, source run, and indented note text wrapped at about 90 columns. Accept/reject
use the full ID, a unique six-hex suffix, or the current list number; ambiguous matches are
refused (use the full ID). Numbers follow the displayed filename order and shift after a
candidate is accepted/rejected, so refresh the list before using another number. `--scope`
overrides the accepted scope; `--supersedes` still takes the older note's full ID.

Every receipt records which memory IDs were supplied, which were proposed, model, tool calls,
tokens and cost, so you can see whether memory helped.

## First results (2026-10-09, Mac, Pi 1.0.4, `openai-2/gpt-6.1-sol`)

- Run `r-20261008T235232Z-d2e609`: answered a question about the Pages bridge with 7 tool calls
  and proposed one note. The note was checked against `pages-mcp.mjs:113` and accepted.
- Same follow-up question, with vs without memory: both correct; with memory 14.4k tokens/$0.013,
  baseline 20.9k/$0.025. Both still re-read the source, as instructed. One sample only.
- `--continue` recalled the previous question and answer with no tool calls.

## Remote runs on dok (2026-10-12)

Hosted callers (ChatGPT/Dots, Claude) start agents with the Hub's `start_run`; it goes to **dok**, the always-on
runner (`../tools/dok-runner/`), so the Mac does not need to be online. dok runs reviewed read-only agents (currently
`helper`) on a fresh depth-1 clone of the bare repo's `main`, mounted read-only in bwrap, with exactly the agent's
tools. `model` (`provider/model`, e.g. `openai/gpt-6.1-sol`) and `thinking` may be overridden per run; the worker
verifies the live SDK session against them. Receipts go to the Hub's D1 `runs` table (`get_run`/`list_runs` read
them with the Mac off). ChatGPT accounts `openai`, `openai-2`, `openai-3` form a pool: a usage-limit error records a
cooldown in the Hub's `accounts` table (shared by every runner) and the read-only run restarts on the next account.
Verified: a run skips an account the Hub marks as cooling down and runs on `openai-2` (2026-10-12). An in-run
usage-limit restart has only unit-test coverage so far.

**Write runs (2026-10-12, Step 3).** Agents with write tools (`workflow`, `vm`, `tikkytracker`) run
the same way, but in a *writable* clone inside the development-session sandbox (no network, no credentials, other runs
invisible), with a 30-minute limit and a 4 GiB disk watchdog; one write run and one read run may run at a time.
`workflow` takes an optional `repo` (default `dev-workflow`); fixed-workspace agents use the repo named like their
workspace, from `repositories` in `dok.json` (bare repos `vm.git`, `tikkytracker.git` next to `dev-workflow.git`; they do not follow GitHub, refresh with `git push dok` from the Mac checkout, whose `remote.dok.push` is `refs/remotes/origin/main:refs/heads/main` after `git fetch origin`). When the agent stops, the harness commits any changes and builds the bundle
*inside the sandbox* (the checkout's git config is agent-controlled), then the supervisor imports it into the bare repo as
the append-only ref `refs/heads/review/runs/<run_id>`; nothing is merged. The receipt carries `review_ref`, `commit`,
`base_commit`, `changed_files`, `repo`; fetch with `git fetch dok 'refs/heads/review/runs/*:refs/remotes/dok-review/runs/*'`.
`continue_from: <run_id>` continues the conversation on the *latest* run of a chain: fresh clone of its review ref and its Pi
session on the same account (reasoning history is account-bound; if that account is limited the run fails and can be
retried). A failover to another account is refused once a write/edit/bash call has happened. Conversations are kept 7 days
(20 newest). The older approval-card route (`request_development`) still exists for interactive sessions.
Verified 2026-10-12: write run `r-20261012T184738Z-c29271` produced a one-line review ref in 30 s; isolation probes in the
container (no network, no Pi auth, no `dok.json`, no repos, sibling runs invisible) all blocked.

**Hub as home for decisions and memory (2026-10-12, Step 4a-4c).** With the Mac off, the panel is served by the Worker from D1:
`panel_data`/`panel_run`/`rate_run`/`review_decide` handle Hub-held runs and notes. The user's decisions need a one-time code
(table `confirmations`, 30 min) that only the panel receives (`_meta`, never model-visible text). Ratings live in `ratings`;
memory in `memory` (candidate → accepted/rejected). A dok run's ```remember blocks ride in its receipt and become candidates;
each run loads the accepted notes for its scopes from `GET /relay/dok-dev/bundle` and records `memory_source`/`memory_hash`
(frozen release only as a fallback). One-time import of `~/.agents/memory`: `tools/hub-import/memory.mjs`. Counts in
`get_status` come from Hub runs. Not moved yet (4d): agent definitions, skills, evals, instruction proposals, the Mac CLI and
the snapshot publisher. Evidence: `../evidence/2026-10-12-hub-state/`.

**The Mac as a Hub client (2026-10-12, Step 4d).** With `~/.config/agent-readonly/mac.json` present (endpoint + its own token; hidden
from agent sandboxes) `agent run`/`chat` post their receipts to the Hub (`/relay/mac/runs`; an outbox in the state folder holds
them while the Hub is unreachable and the next run or `agent sync pull` flushes it), load accepted memory from the Hub bundle
(local files are the offline fallback; receipts say `memory_source`) and send ```remember proposals with the receipt instead of
writing local candidates. Ratings and memory decisions are the Hub panel's: `agent feedback`, `agent memory accept|reject|add`,
`review_decide` and `rate_run` refuse on a linked Mac, and the review queue in `agent ui`/the Claude Code pane is
view-only (live Hub data when reachable, cached items in the local fallback). One writer per kind of data, one direction each: `agent sync pull` mirrors the Hub's decisions into `~/.agents`
git and local receipts; `agent sync push` publishes the committed agent definitions, skills and evals (HEAD of `~/.agents`) to the
Hub, refused if the Hub holds a revision this checkout did not publish. dok runs load the definition, skills and accepted memory for
the agent from the Hub per run (receipt: `memory_source: hub`, `memory_hash` = bundle hash; frozen release only as a fallback;
development sessions still use the frozen release because their grants pin it). Adding or changing an agent = commit in `~/.agents`,
`agent sync push`, restart the dok runner only if a new agent must appear in its runnable list. The Mac relay (`agent link`) and snapshots are retired (`RUNNERS.md`). Tools: `tools/hub-import/{memory,runs}.mjs`.

Code: `dev-sessions.mjs` (runs lane),
`dev-session-worker.mjs` (`executeRun`), Hub `src/runs.mjs`, `src/accounts.mjs`. Evidence:
`../evidence/2026-10-12-dok-runner-step0-1b/`.

### Shared dashboard reads (2026-10-13)

There are two renderers: the Claude Code `agents-panel` mod and `ui/dashboard.html`. Both read the Hub's
`nativePanel` data: the hosted HTML page calls app-only `panel_data`, and a linked Mac's `open_dashboard`
calls `hubPanel()` → `GET /relay/mac/panel`. The Mac route authenticates with its own token, never issues or
returns confirmation codes, and exposes no decision capability. `GET /relay/mac/runs/:id` supplies full Hub
run details, including dok runs. Hosted decision checks and one-time code handling are unchanged.

**Historical traceability (13 October 2026):** both detail renderers use `run-trace.mjs` to show
recorded repository, workspace, checkout branch, review ref, base commit, recorded commit and logs,
with exact values and explicit unavailable labels. Local runs capture the starting Git branch and
commit plus their private JSONL event log path; dok runs record the actual isolated checkout branch
(`agent-run` for writable runs or detached HEAD for read-only runs), alongside the source commit. Hosted receipts intentionally omit Mac workspace and log paths, so
those values remain unavailable there. A review ref is distinct from the checkout branch. No current
Git checkout is consulted and no historical metadata is backfilled or inferred from agent defaults.
Run output remains visible separately from raw logs. Dashboard and plugin renderers consume the same
receipt fields.

**Bounded dok concurrency (13 October 2026):** dok permits up to two read-only and two writable
one-shot runs concurrently, provided they target different repositories. A per-repository lock keeps
same-project runs serialized, and capacity or lock conflicts return an explicit reason before any
receipt or task is started. The existing isolated-clone, disk watermark, account-pool and review-branch
boundaries remain in force. This does not add automatic local fallback or a second executor.

**Configuration visibility (13 October 2026):** run details record the effective provider/model and
thinking level, plus the trusted runner's MCP policy. Pi launches explicitly disable MCP and say so in
the receipt; the dok SDK uses the same no-extension boundary. When a run is started through the local
MCP server, its receipt also carries a bounded observation of that connection's initialize protocol
version, client name/version and advertised capability names. Hosted MCP requests cannot be correlated
to a later run by this stateless relay, so those rows say that connection metadata was not propagated.
Raw initialize parameters, schemas, prompts, credentials and tool arguments are never recorded.

**Partial failure telemetry (13 October 2026, plugins 0.4.2 / dashboard v8):** new failed one-shot
Mac and dok receipts retain bounded assistant text from before the failure, including streamed text
when Pi supplies it. `output_partial` labels that answer as incomplete. `failure_context` records the
last observed phase (`startup`, `model`, or `tool`), last tool name, observed provider/model and a
redacted diagnostic (up to 2,000 characters). Successful output and account-failover policy are unchanged.
Both details views show the error separately, so partial output cannot hide it.

dok keeps a bounded checkpoint in its supervisor for a Pi child exit without final JSON; streamed
checkpoints are throttled to one per second, with immediate terminal-message/tool-start checkpoints.
Thus the latest text can lag, and supervisor/host loss is not a durable progress log. Old receipts are
not backfilled. Reasoning, tool arguments/results, raw logs, stacks and credentials are not new receipt
fields; diagnostics redact credential-looking lines, URLs, host paths and addresses. The existing Hub
receipt route and output redaction remain in use. Failure guidance and live progress are described below.
Interactive Mac chats retain their existing session-receipt behavior.

**Actionable failures (13 October 2026, plugins 0.4.4 / dashboard v10):** full run reads return
`failure_guidance` for failed/interrupted receipts. Both dashboards show a suggested category and one
concrete next step: handshake/protocol, agent/model, environment/SSH, policy/permissions, or Unclassified.
The shared formatter uses terminal status and bounded recorded diagnostics; task text, output and
caller-supplied advice cannot become instructions. Categories are inferences, not verified root causes.
Ambiguous errors stay unclassified; missing Mac contact is still unknown, not a failed run.
Guidance is computed on read, so old receipts benefit without changing stored evidence or restarting
the runner. It never triggers a retry, changes permissions or disables checks. Partial output and the
original error remain visible. Admission/dispatch failures without a run receipt are outside this view.

**Live run visibility (13 October 2026, plugins 0.4.3 / dashboard v9):** one-shot Mac/dok runs
publish event metadata in `progress`: phase, last action/tool, latest completed checkpoint and its
time, and a reported tool/model error while recovery has not been observed. A checkpoint describes
a Pi event, not a durable workspace save or a model-authored plan. No reasoning, assistant text,
tool arguments/results or raw provider errors enter this live field. Phase changes cover preparation,
model response, tool execution and dok review export. Older runs and interactive chats explicitly
say when telemetry is unavailable; no activity is inferred from their old successful receipts.

Mac markers update locally at most once per second for streaming events (tool transitions immediately);
the existing 15-second Hub heartbeat carries the newest observation. dok publishes every five seconds,
serially, and drains in-flight publication before writing the final receipt. The Hub rejects older
running observations that would erase newer progress and never lets a late running receipt replace a
terminal one. Both run lists show a short progress line and both detail views show the shared fields.
After 30 seconds without a new Pi event, the observation is labelled stale and current activity unknown;
that is not proof of a stall. Final-run progress is explicitly historical. Polling/network delays add to
these intervals. Active-run steering and thinking changes remain future work.

The shared view has the agents list, matching agent count, running/to-review counts, and latest 50 runs.
`open_dashboard` performs a single Hub read, without flushing the outbox. On failure it returns current local
data with `source: "local (Hub unreachable)"`; without a Hub link, `source` is `local`. Cached Hub review items
retain their origin, so the Claude Review tab keeps them read-only and shows `DECIDE_IN_HUB`.

The Claude Start tab now uses the runner selection contract described below (superseding its original local-only start). Its Agents tab shows
Hub names, descriptions and last runs. HTML runner health is one summary line with diagnostic details in
native `<details>`; the retired publisher's freshness is no longer displayed.

**VERIFIED EVIDENCE:** the Mac was linked, with no queued outbox receipts; the Hub contained 98 Mac receipts,
including local run `r-20261012T195223Z-45035e` (completed and posted on 2026-10-12).
At that checkpoint only final receipts reached the Hub; the live-publication change below supersedes that limitation.
Evidence and verification results: `../evidence/2026-10-12-dashboard-unification/`.

## Mac running status (2026-10-13)

Linked `agent run` and `agent chat` publish a running receipt through the existing `POST /relay/mac/runs`
route before launching Pi, then heartbeat every 15 seconds after the previous request settles (3-second
request timeout). Both dashboards read that same Hub row. Explicit Mac starts run locally.
On exit, publication stops and drains before the final receipt replaces the running row with the same ID.
Startup failures also publish a failed receipt; an empty interactive chat closes as interrupted.

The Hub uses its own receipt observation time. After 90 seconds without a Mac heartbeat it shows
**unknown**, explains that contact expired, and excludes the run from the running count. This is not
proof of completion or failure. A new heartbeat restores running; a terminal receipt cannot be replaced
by a late heartbeat. Unknown runs have no rating controls or newly issued rating codes.

Running observations are never queued for replay. If the Hub is unreachable, work continues locally;
only the final receipt enters the existing outbox for the next run or `agent sync`. The dashboard retains
its explicit local fallback. No new service, endpoint or dashboard merge path is required.

## Not here yet

Memory retrieval once notes outgrow the prompt, a writer/reviewer pair,
and choosing a runner from the Claude panel. Memory/reviews and ratings already live in the Hub.

## Guards (enforced, not instructed)

Small models follow instructions until a user asks directly: `network` ran `sudo dscacheutil -flushcache`
when asked, despite "never use sudo" (2026-10-09). `guard: readonly` in an agent file loads
`guards/readonly-bash.ts`, a Pi `tool_call` hook that blocks state-changing bash commands (kill, file writes,
redirections, launchctl, network/VPN/DNS changes, installs, sudo outside `sudo_allow:`) before they run and
tells the model to give the user the command instead. Blocked attempts are recorded in run receipts as
`blocked` and shown to the coach. Tests: `node --test agent-workflow/guards/`.


### Developer agents (`guard: workspace` + `write_paths`)

`workflow` (2026-10-09) edits, tests and commits like a developer. Two layers keep that bounded:
- **Sandbox (hard):** with `write_paths:` in the agent file, `agent` starts Pi under macOS `sandbox-exec`. Writes in the
  home folder are denied except in `write_paths` and Pi's own folders; credential stores (`~/.ssh`, keychains, cookies,
  `~/.codex/auth.json`, …) can't be read. Verified: a write to `~` fails with "Operation not permitted".
  The launcher marks sandboxed children with `AGENT_SANDBOXED=1`. Nested sandboxed run/chat/eval
  invocations fail early with a command for the user to run from an unsandboxed terminal, rather than
  Pi exiting with code 71; evals abort instead of reporting a misleading 0/N score.
- **Guard (policy):** `guards/workspace-bash.ts` blocks sudo, process kills, system/app settings, installs outside the
  project, git push and history rewrites, mentions of credential files, and the user's own decisions (`agent memory`,
  `agent feedback`, `agent review accept|reject`). `edit`/`write`/bash file changes to protected paths are blocked:
  the agent's own definition, accepted/rejected memory, rejected proposals, and `protect_paths:`.

First runs: "what am I working on?" in 13 s / $0.001; a small feature (agent list details) with a test and commit in
1m46 / $0.01. Lesson: it staged whole files and so committed another session's uncommitted changes in the same file
(86b27a1); its instructions now require checking `git diff` before staging.

## Using agents from other apps (`ops.mjs`, `mcp.mjs`, `ui/`)

`ops.mjs` is the one list of operations other apps get, each with a JSON schema and an access level:
**read** (`open_dashboard`, `get_status`, `list_agents`, `list_runs`, `get_run`, `list_pending`),
**run** (`run_agent`, `start_run`, `run_eval`) and **decide** (`rate_run`, `review_decide`: the user's own decisions).
Every surface is built from it: the stdio MCP server `mcp.mjs` (`agent mcp`), `agent call <op> '{json}'`,
the local dashboard and the Pi package in `../plugins/agents/`; the hosted Hub shares the read contract.
Legacy `run_agent` and `start_run` use Pi on this Mac; hosted starts use dok. Updated local panels use `start_selected_run` with an explicit target.

- `start_run` returns a run id at once and runs `agent run` in the background. Every run writes
  `runs/<id>.running` while it works; `listRuns(state, { running: true })` shows those (as `interrupted` if the
  process died without a receipt). Plain `listRuns` still returns finished receipts only.
- `run_agent`/`start_run` accept an optional absolute `cwd` for agents whose `workspace` is `here`; calling apps
  should pass their project folder. Passing `cwd` for a fixed-workspace agent is an error.
- **Agents Hub dashboard** (`ui/dashboard.html`): runs (detail, live status, rating), agents, review queue (accept/reject),
  run form. `open_dashboard` points MCP App hosts at `ui://agents/dashboard.html` (`text/html;profile=mcp-app`,
  plus the `openai/outputTemplate` alias); the ext-apps bridge is vendored in `ui/vendor/` and inlined.
  `agent ui` serves the same page on 127.0.0.1 with a per-launch token while the command runs.
- Pi processes started for an agent get `AGENT_RUN=1`, so the Pi package leaves them alone.

Hosted ChatGPT, Dots and Claude use the Agents Hub Worker (`../agent-readonly-service/`): runs start on dok and runs, ratings, memory and
agent definitions live in the Hub's D1. See `RUNNERS.md` for who runs what; the Mac relay and snapshots are retired.

Registered (2026-10-09) in Claude Code (`claude mcp add -s user agents -- node .../mcp.mjs`), Codex
(`codex mcp add agents -- node .../mcp.mjs`) and Claude Desktop; `../plugins/agents/` packages it for all three
plus Pi (see `../plugins/README.md`). Verified: Claude Code `-p` ran `network` through `run_agent` and relayed
its answer; Codex `exec` used the read-only tools, while `run_agent` was refused by Codex's headless approval
policy (`never`); interactive Codex asks for approval instead. Test by hand:
`echo "ask the network agent if my VPN is on" | claude -p --allowedTools mcp__agents__run_agent`.


### model gateway in sandboxed agents (2026-10-09)

`agent chat` and `agent run` resolve the installed `private-gateway-provider` package
and start its authenticated loopback broker outside the agent sandbox. model gateway
starts only on the first model gateway request, so it can use the user's Keychain for
its own authentication. Pi retains the existing filesystem and credential-store
restrictions. The broker and gateway stop when the Pi child exits; temporary
credentials remain in memory. Restart an existing chat after launcher updates
(`agent chat workflow --continue` resumes it); `/reload` alone cannot create a
broker in an already running launcher. Ordinary unsandboxed Pi uses its direct
gateway as before. This requires the provider package's `broker.mjs` support.

## Runner selection (2026-10-13, 0.4.0)

The Claude Start tab and local HTML dashboard default to **dok**, even if unavailable. Choose
**This Mac** explicitly for local execution. The hosted ChatGPT dashboard stays dok-only. Switching
runner preserves the task and clears incompatible directory/continuation fields. Both forms show the
effective model and repository/directory where known. dok uses its repository checkout; tasks that
produce changes use the existing review-branch workflow and do not modify this Mac's working tree.

`open_dashboard` adds `runner_selection: 1`, runner-specific `run_targets`, and saved `start_requests`.
New panels call `start_selected_run({runner,agent,task,request_id,cwd?,continue?})`; explicit invalid or
missing runners and hidden overrides are rejected. Older operation catalogs reject the new name,
so an old handler cannot ignore dok selection and run locally. Legacy `run_agent`/`start_run` keep
their existing local behavior. dok never falls back on 404, offline, authentication or timeout errors.
Local discovery and explicit Mac execution do not require a successful Hub request.

The Mac's existing credential gains only permission to request existing allowed dok runs through
`POST /relay/mac/start` (agent, task, request_id only). Admission rechecks dok eligibility, and the
supervisor retains its existing agent allowlist, repository permissions, isolation and approval rules.
No review/rating permission or confirmation codes are added. The loopback browser bridge retains
its Host check, per-launch token header and absence of CORS permission.

Before submission, the operation durably saves its request identity in `STATE/selected-starts/`.
Reusing that identity with changed arguments fails; simultaneous identical submissions dispatch once.
An unresolved identical task with a new identity reconciles the original. `get_selected_start` reads
`GET /relay/mac/starts/:id`: the Hub checks receipts/relay state, then dok's existing durable request
journal through `run_lookup`. It never dispatches another start. Mac request IDs use the reserved
`mac-` namespace at the Hub. The local journal survives panel closure; dok's journal survives relay
cache expiry. Missing lookup results stay **unknown**, never become permission for a fresh retry.
A returned run ID means a start was accepted; inspect its receipt for running/completed/failed status.

Timeouts: relay attempt 20 seconds, Mac Hub request 30 seconds, Claude operation 40 seconds.
These bounds do not prove delivery: recovery uses durable identities, including after disconnection.
No new executor, relay, synchronization service, model/repository picker or remote continuation is added.
