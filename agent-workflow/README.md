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

## Not here yet

Running agents from hosted ChatGPT/Dots (they can read the catalog and runs through `agent-readonly-service/`, see
`evidence/2026-10-09-dots-agents-connector/`; the candidate route for running is OpenAI's Secure MCP Tunnel), memory
retrieval once notes outgrow the prompt, a writer/reviewer pair, and cloud-only agents (Cloudflare PiHarness).

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

## Using agents from other apps (`mcp.mjs`)

A dependency-free local stdio MCP server over the same code: `list_agents`, `run_agent`, `list_runs`, `get_run`,
`rate_run`, `list_pending`, `review_decide`, `run_eval`. Ratings and proposal decisions are described to the
calling model as the user's to give.

`run_agent` accepts an optional absolute `cwd` string for agents whose `workspace` is `here`
(as reported by `list_agents`). Calling apps should pass their project folder so the agent works there
and continuation uses that project's history. Omit it to use the MCP server's current directory.
Passing `cwd` for a fixed-workspace agent is an error; the same home-folder restrictions apply.

Hosted ChatGPT and Dots use a separate read-only Worker instead (`../agent-readonly-service/`): `agent` publishes a
sanitized snapshot after each run and chat when `~/.config/agent-readonly/publish.env` exists.

Registered (2026-10-09) in Claude Code (`claude mcp add -s user agents -- node .../mcp.mjs`) and Codex
(`codex mcp add agents -- node .../mcp.mjs`). Verified: Claude Code `-p` ran `network` through `run_agent` and relayed
its answer; Codex `exec` used the read-only tools, while `run_agent` was refused by Codex's headless approval
policy (`never`); interactive Codex asks for approval instead. Test by hand:
`echo "ask the network agent if my VPN is on" | claude -p --allowedTools mcp__agents__run_agent`.

