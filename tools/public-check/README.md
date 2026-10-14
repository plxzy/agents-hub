# public-check

Fails if a private value appears in tracked files, or with `--history` anywhere in history (blobs and commit messages):
`node tools/public-check/check.mjs [--history] [path...]`. The values are regular expressions, one per line, in
`PRIVATE_VALUES` (default `~/.config/agents-hub/private-values.txt`), which is never committed. Output shows only the
matched value and where it is.
