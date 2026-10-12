#!/usr/bin/env bash
# Operator action: install a committed implementation without executing checkout code.
set -euo pipefail
repo=${1:?usage: install-workflow.sh REPOSITORY KNOWLEDGE_RELEASE}
knowledge=$(realpath "${2:?knowledge release required}")
context=${4:-}
if test -n "$context"; then context=$(realpath "$context"); fi
test -f "$knowledge/RELEASE.json"
revision=$(git -C "$repo" rev-parse "${3:-HEAD}^{commit}")
base="$HOME/.local/share/agent-workflow/releases"
release="$base/$revision"
mkdir -p "$base" "$HOME/.local/bin"
if test ! -d "$release"; then
  candidate=$(mktemp -d "$base/.candidate-XXXXXX")
  git -C "$repo" archive "$revision" agent-workflow | tar -x -C "$candidate"
  npm ci --prefix "$candidate/agent-workflow" --ignore-scripts --no-audit --no-fund
  printf '%s\n' "$revision" > "$candidate/REVISION"
  chmod -R a-w "$candidate"
  mv "$candidate" "$release"
fi
# The wrapper contains resolved release paths; updating the checkout does not reload it.
wrapper=$(mktemp "$HOME/.local/bin/.agent-XXXXXX")
printf '#!/bin/bash\nexport PATH="$HOME/.local/bin:$PATH"\nexport AGENT_HOME=%q\nexport AGENT_CONTEXT_ROOT=%q\nexec /usr/local/bin/node %q "$@"\n' \
  "$knowledge" "$context" "$release/agent-workflow/agent.mjs" > "$wrapper"
chmod 700 "$wrapper"
if test -e "$HOME/.local/bin/agent"; then
  cp -P "$HOME/.local/bin/agent" "$base/previous-launcher-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mv "$wrapper" "$HOME/.local/bin/agent"
# The runner container's main process; it reads its own private config path argument.
supervisor=$(mktemp "$HOME/.local/bin/.agent-supervisor-XXXXXX")
printf '#!/bin/bash\nexport PATH="$HOME/.local/bin:$PATH"\nexec /usr/local/bin/node %q "$@"\n' \
  "$release/agent-workflow/dev-supervisor.mjs" > "$supervisor"
chmod 700 "$supervisor"
mv "$supervisor" "$HOME/.local/bin/agent-supervisor"
printf 'Activated implementation %s; knowledge %s\n' "$revision" "$(basename "$knowledge")"
