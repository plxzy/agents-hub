# tern-agents-hub

A [Tern](https://docs.stencil.so/tern) plugin that puts the Agents Hub in a native side panel:
runs (newest first, with status, agent, duration, cost, current running step and PR number), pending-review
count and runner status. The data comes from the operations catalog — one `agent call open_dashboard`
per poll, then one serial `agent call get_run` per running run for its progress step. The panel also
lists pending reviews and can accept or reject a selected item after confirmation.

## Install

```sh
tern plugin link "$PWD/plugins/tern-agents-hub"   # from the repository root
tern plugin reload
```

Open it from the palette: **Agents Hub** (or `⌘⌥⇧H` on macOS); it opens beside the current pane, or
focuses the one already open. The status line shows `Hub 1 running · 3 to review` (also
`unreachable` or `<runner> offline`; nothing when there is nothing to report; click it to open the
panel). Tern's status bar is off by default: turn it on (`status_bar` in Tern's settings) to see it.

One poll loop runs in the host half for as long as the plugin is loaded: every 5 s while a run is
running, every 20 s when quiet (opening a panel or `r` polls at once). It writes a small `snapshot`
(counts, runner, updated time, and runs running or finished in the last 10 minutes) to the plugin's
`tern.kv`, which the status segment and the omp widget (`../omp-agents-hub`) read; each run has `id`,
`agent`, `status`, `started`, optional `ended`, optional published `pr`, and running `step` (the
progress action or phase, with underscores replaced and capped at 40 characters). Terminal runs
transitioning from running produce one window toast. Open panels render from the same fetch. Errors
show inline in the panel.

## Keys

- `↑/↓` or `k/j` move runs; `⏎` opens the selected run's detail (status, model, cost, PR link, current
  step, progress rows and the head of the output).
- `p` opens pending reviews; `↑/↓` or `k/j` selects an item, `⏎` shows its full body, `q`/`Esc` goes
  back, and `a`/`x` then the same key (or `y`) confirms accept/reject. `r` refreshes the current view.
- `q`/`Esc` closes run detail.

## Development

Luau types for luau-lsp: `tern plugin types plugins/tern-agents-hub` writes `tern.d.luau`
(git-ignored; rerun after a Tern update), then
`luau-lsp analyze --definitions=tern.d.luau host.luau window.luau` in the plugin folder. After
edits: `tern plugin reload`. Layout and idioms follow the SDK's `plugins/examples/review-queue`.
