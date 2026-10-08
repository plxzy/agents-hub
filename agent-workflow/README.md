# agent-workflow

Step 1–2 of the progressive agent plan (2026-10-09): plain Pi agents defined as files, with
layered memory that the user reviews. No Cloudflare, no registry, no control plane. It follows
the brief *dev-workflow-agent-context*: portable
knowledge first, one direct specialist, curated memory compared against a no-memory baseline.

```sh
alias agent="node ~/Development/dev-workflow/agent-workflow/agent.mjs"
agent list
agent run helper "where is the update-comparison tooling and what does it produce?"
agent run helper --continue "and how do I run it?"     # same Pi session
agent run helper --no-memory "..."                      # baseline without reviewed memory
agent runs                                              # receipts
agent memory                                            # candidates to review
agent memory accept <id> [--scope s] [--supersedes old-id]
agent memory reject <id> [reason]
node --test agent-workflow/                             # tests
```

## Layout

| Path | What | Owner |
|---|---|---|
| `agents/<name>.md` | Definition: frontmatter (`tools`, `workspace`, `memory` scopes, optional `model`, `thinking`) + instructions | You, versioned |
| `memory/shared/`, `memory/projects/<p>/`, `memory/agents/<a>/` | Accepted memory, one fact per file | You, versioned |
| `memory/candidates/` | Proposed by agents, never shown to agents until accepted | Agents propose, you decide |
| `memory/rejected/` | Rejected proposals, kept as evidence | |
| `~/.local/state/agent-workflow/` (`AGENT_WORKFLOW_STATE`) | Run receipts, raw Pi events, Pi sessions per agent | Private, not in git |

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
