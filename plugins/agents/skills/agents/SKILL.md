---
name: agents
description: Use when the user mentions their own agents (helper, workflow, videotor, network, or "my agents"), wants to delegate a task to one, check what agents ran or are running, see what waits for their review, or open the agents dashboard. Covers which tool to use and which decisions only the user may make.
---

# The user's own agents

The `agents` MCP server reaches the user's Pi agents on their Mac. Each agent has its own instructions, tools,
sandbox, guard and reviewed memory; the agent decides how to do the work, you decide whether to delegate.

## Pick the tool

| The user wants to… | Use |
|---|---|
| see everything at a glance, manage agents | `open_dashboard` (renders a dashboard where the host supports MCP Apps; elsewhere it returns a summary) |
| know what agents exist / which fits | `list_agents` |
| hand a task to an agent and wait for the answer | `run_agent` (seconds to minutes) |
| hand off something long, or keep working meanwhile | `start_run`, then `get_run` with the returned `run_id` |
| check recent work | `list_runs`, `get_run` |
| see what waits for them | `list_pending` |

- Pass the user's request as `task`, in their words; don't pre-solve it.
- Agents with `workspace: here` (e.g. `workflow`) work in a project folder: pass the absolute project folder as `cwd`.
  Other agents have a fixed workspace and refuse `cwd`.
- `continue: true` follows up in the same agent conversation.
- Report the agent's answer and the run line (run id, status, cost) faithfully. If a guard blocked something, say so.

## Decisions belong to the user

`rate_run` and `review_decide` record the user's own judgment (ratings, accepting or rejecting memory notes,
test cases and instruction edits). Call them only when the user has just stated that decision for that specific
item. Never rate, accept or reject on your own initiative, and never batch-accept. In the dashboard the user
can click these themselves.

## When it fails

- `cannot start a sandboxed agent from inside a sandbox`: you are running inside an agent's sandbox; tell the user
  the command to run themselves (`agent run <agent> "<task>"`).
- `unknown agent`: call `list_agents` and use an exact name.
