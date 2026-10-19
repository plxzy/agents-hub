# tern-agents-hub

A [Tern](https://docs.stencil.so/tern) plugin that puts the Agents Hub in a native side panel:
runs (newest first, with status, agent, duration, cost and PR number), pending-review count and
runner status. The data comes from the operations catalog — one `agent call open_dashboard`
per poll, `agent call get_run` for a run's detail — so it reads exactly what the other Agents Hub
panels read. Read-only: ratings, memory decisions and starting runs stay in the apps where you
make them.

## Install

```sh
tern plugin link ~/Development/agents-hub/plugins/tern-agents-hub
tern plugin reload
```

Open it from the palette: **Agents Hub** (or `⌘⌥⇧H` on macOS). The block polls every 5 s while
something is running, backing off to 30 s when quiet and 60 s after an error.

## Keys

- `↑/↓` or `k/j` move, `⏎` opens the run's detail (model, usage, PR link, output, progress),
- `q`/`Esc` closes the detail, `r` refreshes.

## Development

Luau types for luau-lsp: `tern plugin types plugins/tern-agents-hub` (writes `tern.d.luau`,
git-ignored). After edits: `tern plugin reload`. Layout and idioms follow the SDK's
`plugins/examples/review-queue`.
