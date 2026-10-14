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
| follow up on a published PR | Read `get_run`, then `start_run` with `repo` and `pr_number`; it fetches the current PR head, including reviewer fixes |
| follow up on an internal review | Read `get_run`, then `start_run` with `continue_from` set to the latest completed conversation run |
| review a PR locally | `checkout_review` with the primary repository `cwd` and `pr_number`; use its PR branch and worktree, then `finish_review` |
| recover failed/interrupted work | Read `get_run`; follow `next_action` and use `resume_run` with its checkpoint version, or the Hub recovery card when inspection approval is required |
| reconcile a lost start response | `get_start_status` with the original request ID; never invent another identity |
| check recent work | `list_runs`, `get_run` |

- Pass the user's request as `task`, in their words; don't pre-solve it. Read-only agents (helper) answer questions;
  agents that change files (workflow, vm, tikkytracker) work in an isolated clone with no network and return a review
  result. For GitHub-enabled repositories, report the PR link and branch from `get_run.review` or `publication`; poll until publication succeeds or blocks.
  `review_ref` is an internal saved snapshot, not another branch to work on. Nothing is merged automatically. Say which checks could not run on dok.
- `workflow` also takes a `repo` argument when it should work in another repository. `model` and `thinking` override
  the agent's defaults for one run.
- Mac-only work (the `network` agent, `workspace: here` in the current folder): the local server's `run_agent`, or tell
  the user to run `agent run <agent> "<task>"`.
- Report the agent's answer and the run line (run id, status, cost) faithfully. If a guard blocked something, say so.

## Decisions belong to the user

Ratings and accepting or rejecting memory notes are the user's clicks in the Agents Hub panel (`open_dashboard`). The
tools for them are hidden from you on purpose, and the Mac cannot make them either. Never try to rate, accept or reject
on your own initiative.

## Continuity and retained work

- A run ID or PR number only in task text is context, not a checkout selection. Use `pr_number` for a published PR or `continue_from` for an existing run, never both. Published continuations fetch the current open PR head; internal reviews retain their saved source.
- A no-edit review keeps `source_pr` or `source_review`; `changed_files: []` does not mean the original patch disappeared. Historical run commits and current PR observations are separate facts.
- `review_ref` and `artifact` identify a private Hub export, not a GitHub branch or PR. Use the verified bundle importer only for an internal/unpublished artifact or recovery. Normal reviews and fixes use the PR branch.
- If conversation history expired for an open published PR, select its `pr_number` to continue the current code. For an internal review, import the original artifact. Do not rerun the patch on main or ask a new sandbox to search other runs.
- Recovery uses the original files and checkpoint, with a linked new run ID. Uncertain commands require the user's Hub card; the model cannot approve them.
- If recovery tools are missing from the client, refresh connector discovery or use the Hub panel. Report the capability gap; never emulate recovery with a fresh run.

## When it fails

- `No runner is online`: dok and the Mac relay are both offline; say so, don't retry in a loop.
- `Agent is not runnable on dok` / `dok does not run <agent>`: call `get_status` and use a name listed under
  `start_run.runners.dok`.
- `dok runner is busy`: per-repository or runner capacity is occupied; wait for the current run and reuse the original request identity.
- `cannot start a sandboxed agent from inside a sandbox` (local server): you are inside an agent's sandbox; tell the
  user the command to run themselves.

## PR lifecycle and cleanup

- Keep all review fixes on the same PR branch. Use `checkout_review`; do not create a second alias branch or reset local main.
- If the branch moved during a Hub run, publication blocks and preserves its result. Reconcile that saved patch into the PR branch using the verified artifact importer, test, then retry `publish_review`. Do not start a fresh run to discard unpublished work.
- Merged/closed PRs are terminal. New work starts a new PR from current main. Merge authorization and checks remain the user's existing policy.
- `finish_review` releases a local checkout session; it does not push or merge. Enabled cleanup runs on finish and the next checkout. `cleanup_reviews` previews older review branches; `apply: true` removes only proven merged, inactive, clean work.
- Preserve dirty/ignored files, active sessions, stashes, unpublished commits and internal snapshots. Local main's divergence is separate; never reset it as review cleanup.
