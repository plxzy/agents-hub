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
agent memory accept <id> [--scope s] [--supersedes old-id]
agent memory reject <id> [reason]
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
- **The coach** (`agent reflect`) is a no-tools Pi call that sees the definition, reviewed memory, recent
  task runs with your ratings, and the latest test results. It may propose notes, new test cases, and at
  most one instruction rewrite; it may not add tools or permissions. Its input and output are kept in
  `~/.local/state/agent-workflow/reflections/`.
- **Versions:** `~/.agents` is a git repo (only `agents/`, `memory/`, `evals/`, `proposals/` are tracked), so
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

Every receipt records which memory IDs were supplied, which were proposed, model, tool calls,
tokens and cost, so you can see whether memory helped.

## First results (2026-10-09, Mac, Pi 1.0.4, `openai-2/gpt-6.1-sol`)

- Run `r-20261008T235232Z-d2e609`: answered a question about the Pages bridge with 7 tool calls
  and proposed one note. The note was checked against `pages-mcp.mjs:113` and accepted.
- Same follow-up question, with vs without memory: both correct; with memory 14.4k tokens/$0.013,
  baseline 20.9k/$0.025. Both still re-read the source, as instructed. One sample only.
- `--continue` recalled the previous question and answer with no tool calls.

## Not here yet

Cloudflare reporting, a list/read API that Dots or other clients can call, more agents, and a
writer/reviewer pair. The earlier `contracts/` and `cloudflare/agent-registry/` work is the
candidate for that later step.
