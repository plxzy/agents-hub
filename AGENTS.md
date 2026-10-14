# agents-hub — agent guide

This is the public home of the agent system (CLI, Hub Worker, dok runner, plugins). Everything committed here is public.

- **Never commit deployment values** (account or database ids, Access settings, hostnames, tokens, personal paths). They live in
  private config outside the repo (`hub.example.json` shows the shape). `.githooks/pre-push` runs `tools/public-check/check.mjs`
  against the owner's private list; enable it once per clone with `git config core.hooksPath .githooks`.
- **Private extensions stay private:** provider account extensions come in through the runner's `AGENTS_EXTENSIONS` build
  context, the sandboxed model gateway through `AGENT_MODEL_GATEWAY`. Don't add provider-specific code for them here.
- **Tests:** `npm run setup && npm test` (keep the checkout inside your home folder). CI runs the same on Node 26.
- **Deploying:** Hub — `cd agent-readonly-service && npx cf deploy --dry-run && npx cf deploy` (use `cf`, not wrangler).
  Runner — push to `main`, then on dok `cd ~/agents-runner && ./install.sh <commit>`; rebuild the image only when
  `tools/dok-runner/` or the private extensions change. Don't restart the runner while a run is active.
- Commit when a unit of work is done; work on `main` unless asked for a branch.
