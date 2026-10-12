---
name: agents
description: Use when the user mentions their own agents (helper, workflow, vm, tikkytracker, network, or "my agents"), wants to delegate a task to one, check what agents ran or are running, see what waits for their review, or open the agents dashboard. Covers which tool to use and which decisions only the user may make.
---

# The user's own agents

Agents Hub reaches the user's Pi agents. In Claude Code, Claude Desktop and claude.ai it is the **Agents Hub connector**
(hosted; works with the Mac off): agents run on dok, the user's always-on Linux runner. Codex and Pi also have a local
`agents` server that runs agents on the Mac. Each agent has its own instructions, tools, sandbox, guard and reviewed memory;
the agent decides how to do the work, you decide whether to delegate.

## Pick the tool

| The user wants to… | Use |
|---|---|
| see everything at a glance, manage agents | `open_dashboard` (a dashboard where the host supports MCP Apps; elsewhere a summary) |
| know which agents exist and are online | `get_status` (see `start_run.runners.dok`), `list_agents` |
| ask about a repository, or have code changed in dev-workflow, vm or tikkytracker | `start_run` with that agent, then poll `get_run` with the returned `run_id` |
| follow up on code an agent changed | `start_run` with `continue_from` set to the previous run id |
| check recent work | `list_runs`, `get_run` |

- Pass the user's request as `task`, in their words; don't pre-solve it. Read-only agents (helper) answer questions;
  agents that change files (workflow, vm, tikkytracker) work in an isolated clone with no network and return a review
  branch: `review_ref` in `get_run`, fetched with `git fetch dok`. Nothing is merged for the user. Report the branch
  and the changed files, and say which checks could not run on dok.
- `workflow` also takes a `repo` argument when it should work in another repository. `model` and `thinking` override
  the agent's defaults for one run.
- Mac-only work (the `network` agent, `workspace: here` in the current folder): the local server's `run_agent`, or tell
  the user to run `agent run <agent> "<task>"`.
- Report the agent's answer and the run line (run id, status, cost) faithfully. If a guard blocked something, say so.

## Decisions belong to the user

Ratings and accepting or rejecting memory notes are the user's clicks in the Agents Hub panel (`open_dashboard`). The
tools for them are hidden from you on purpose, and the Mac cannot make them either. Never try to rate, accept or reject
on your own initiative.

## When it fails

- `No runner is online`: dok and the Mac relay are both offline; say so, don't retry in a loop.
- `Agent is not runnable on dok` / `dok does not run <agent>`: call `get_status` and use a name listed under
  `start_run.runners.dok`.
- `dok runner is busy`: one run (and one write run) at a time; retry in a minute.
- `cannot start a sandboxed agent from inside a sandbox` (local server): you are inside an agent's sandbox; tell the
  user the command to run themselves.
