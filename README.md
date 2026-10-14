# Agents Hub

Run your own [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agents on an always-on Linux machine and review their work from
ChatGPT, Claude, Codex or a browser. Agents are plain Markdown files. Runs happen in isolated clones and never merge
anything themselves: every change comes back as a saved review, and for GitHub repositories as a draft pull request.
Memory is something the agent proposes and you accept.

This is the system its author uses every day, not a sample. The [fixture demo](#try-the-demo) shows the dashboard with sample data.
The rest of this README explains how to run the whole thing yourself.

## How it fits together

```
 ChatGPT / Claude / Codex ──MCP (OAuth via Cloudflare Access)──┐
                                                                ▼
 Mac or laptop ── agent CLI, panels ──token──▶  Hub (Cloudflare Worker + D1 + R2 + Durable Object)
                                                                ▲
                          one outbound WebSocket, machine token │
                                                                │
                                Runner (Docker on a Linux box: supervisor + Pi + bubblewrap)
                                    └─ review publisher (optional) ──▶ GitHub draft PRs
```

| Path | What |
|---|---|
| `agent-workflow/` | The `agent` CLI (agents as files, reviewed memory, evals, improvement loop), the operations catalog every surface uses (`ops.mjs`), the MCP server, the dashboard (`ui/`) and the runner supervisor (`dev-supervisor.mjs`, Linux sandbox, recovery) |
| `agent-readonly-service/` | The Hub: a Cloudflare Worker with MCP, Access-verified sign-in, D1 (runs, ratings, memory, decisions), R2 review bundles and the runner relay |
| `tools/dok-runner/` | The runner container: Dockerfile, Compose file, install and health scripts |
| `tools/review-publisher/` | Optional GitHub App publisher that turns saved reviews into draft PRs |
| `tools/run-artifact/` | Imports a run's review bundle into a local clone |
| `plugins/` | One plugin folder for Claude Code, Codex and Pi, plus a Claude Code side panel |
| `demo/`, `cloudflare/` | The fixture demo and its static deployment |

Each folder has its own README with the details. `agent-workflow/RUNNERS.md` describes how runs are routed. The runner is
called `dok` in code and docs, after the machine it runs on; `dok-dev` is its id in the relay protocol.

## Try the demo

```sh
npm ci && npm run demo        # prints a local URL
```

## Run it yourself

You need Node 26, a Cloudflare account, a Linux host with Docker (the runner) and a model login that Pi supports.

1. **Install and test.**
   ```sh
   npm ci && npm run setup && npm test
   ```
   Some tests need the checkout to be inside your home folder.
2. **Agents.** Agents live in `~/.agents` (`AGENT_HOME`), which is a git repository you own. Link the CLI and write your
   first agent:
   ```sh
   ln -s "$PWD/agent-workflow/agent.mjs" ~/.local/bin/agent
   agent list
   agent run <name> "a question"
   ```
   `agent-workflow/README.md` documents the definition format (tools, model, workspace, memory scopes), evals and
   memory review.
3. **Hub.**
   - Create a D1 database and an R2 bucket.
   - Copy `agent-readonly-service/hub.example.json` to `~/.config/agents-hub/hub.json` and fill it in.
   - Apply `agent-readonly-service/migrations/` with `cf`.
   - Put Cloudflare Access with Managed OAuth in front of `/mcp`.
   - Set the Worker secrets `DOK_RELAY_TOKEN`, `MAC_TOKEN` and, optionally, `REVIEW_PUBLISHER_TOKEN`.
   - Deploy:
     ```sh
     cd agent-readonly-service && npx cf deploy --dry-run && npx cf deploy
     ```

   Without the config file the build stops, so a deploy can never bind placeholders. Run `HUB_LOCAL=1` with `cf dev`
   to work on it locally.
4. **Runner.**
   - Copy `tools/dok-runner/` to the Linux host and build the image.
   - Create the `agents-home` volume and write the runner config (`~/.config/agent-workflow/dok.json` inside the
     volume: Hub endpoint, machine token, repositories, limits).
   - Sign in to Pi once inside the container.
   - Start it.

   `tools/dok-runner/README.md` covers installs, upgrades and rollback. Optional private Pi extensions are passed as a
   build context (`AGENTS_EXTENSIONS`) and are never part of this repository.
5. **Connect clients.**
   - Add the Hub's `/mcp` URL as a custom connector in ChatGPT or Claude.
   - Install `plugins/` in Claude Code, Codex or Pi (see `plugins/README.md`).
   - `agent ui` opens the dashboard in a browser.
6. **GitHub (optional).** Create a GitHub App and run `tools/review-publisher/` next to the runner, so that reviews for
   enabled repositories become draft PRs.

## Safety model, briefly

- **Models cannot decide.** Ratings, memory and review decisions are clicks in the panel, backed by one-time codes the
  model never sees.
- **Write runs are contained.** They get a writable clone with no network, a time limit and a disk watchdog. Their
  result is an append-only review ref.
- **Read-only agents are contained too.** They run in a read-only bubblewrap sandbox with a path guard.
- **The Hub stores sanitised receipts.** Unknown fields are dropped and lines that look like secrets are redacted.

## Keeping private things private

Deployment values (account ids, Access settings, hostnames, tokens) live in config files outside the repository.
`tools/public-check/check.mjs` fails if any value from a private list appears in tracked files or in history.

## History

Development started in a private workspace on 2026-10-09. The commits before the merge into this repository are that
real history, filtered to these paths and scrubbed of deployment details. See `history/README.md`.

## License

MIT. The vendored MCP Apps bridge keeps its upstream license (`agent-workflow/ui/vendor/ext-apps-LICENSE`).
