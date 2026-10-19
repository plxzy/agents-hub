# tern-agents-hub

A [Tern](https://docs.stencil.so/tern) plugin that puts the Agents Hub in a native side panel:
runs (newest first, with status, agent, duration, cost and PR number), pending-review count and
runner status. The data comes from the operations catalog — one `agent call open_dashboard`
per poll, `agent call get_run` for a run's detail — so it reads exactly what the other Agents Hub
panels read. Read-only: ratings, memory decisions and starting runs stay in the apps where you
make them.

## Install

```sh
tern plugin link "$PWD/plugins/tern-agents-hub"   # from the repository root
tern plugin reload
```

Open it from the palette: **Agents Hub** (or `⌘⌥⇧H` on macOS); it opens beside the current pane, or
focuses the one already open. The block polls every 5 s while a run is running and doubles the
delay up to 60 s when nothing is; it stops polling when its pane closes. `agent` is looked up in
`~/.local/bin`, Homebrew and `PATH`. Errors show inline in the panel.

## Keys

- `↑/↓` or `k/j` move, `⏎` opens the run's detail (status, model, cost, PR link, progress rows,
  the head of the output),
- `q`/`Esc` closes the detail, `r` refreshes.

## Development

Luau types for luau-lsp: `tern plugin types plugins/tern-agents-hub` writes `tern.d.luau`
(git-ignored; rerun after a Tern update), then
`luau-lsp analyze --definitions=tern.d.luau host.luau window.luau` in the plugin folder. After
edits: `tern plugin reload`. Layout and idioms follow the SDK's `plugins/examples/review-queue`.
