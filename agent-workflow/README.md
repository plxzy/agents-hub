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
Verified so far: slot ordering from Hub state and single-account runs; failover to a second account is **unverified**
until the extra accounts are logged in on dok.
The Mac relay remains a fallback for agents dok does not offer. Code: `dev-sessions.mjs` (runs lane),
`dev-session-worker.mjs` (`executeRun`), Hub `src/runs.mjs`, `src/accounts.mjs`. Evidence:
`../evidence/2026-10-12-dok-runner-step0-1b/`.

## Not here yet

Memory retrieval once notes outgrow the prompt, a writer/reviewer pair, write runs on dok (`workflow` one-shot with
review branches), and the Hub as home for memory/reviews (today reviews and ratings still need the Mac).

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
the dashboard, the Pi package in `../plugins/agents/`, and later the hosted hub. Runs go through a runner
(`runner:` in the agent file, `local` = Pi on this Mac; only `local` exists so far).

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

Hosted ChatGPT and Dots read sanitized snapshots from the Agents Hub Worker (`../agent-readonly-service/`);
its optional foreground Mac relay separately enables helper-only remote starts and user-click review controls.
Published snapshot `capabilities.run:false` / `mutate:false` stay read-only even when live relay state is online
and enabled. `agent` publishes snapshots after runs/chats when the existing publisher configuration exists.

`agent link doctor --json` is a read-only one-shot report, not a relay launcher or heartbeat. It separates observed
live state from local configuration and historical run completion, preserving unknowns where sources are unavailable.
`--input observations.json` can inspect one existing raw hosted status/dashboard observation; it does not refresh it.
The dashboard and existing `get_status` reuse the additive health report. See `LINK.md` for sources, sandbox limits,
helper-only wording and exit codes (0 fresh connected/enabled or deliberately off, 1 disconnected/mismatch, 2 unknown).
No new background service, polling fallback or unattended monitoring is introduced. This Plan 1A patch is local only.

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
