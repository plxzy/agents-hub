#!/usr/bin/env bash
# Run as the coding user inside dok-dev. Never overwrites an installed release.
set -euo pipefail
umask 077
action=${1:-status}
version=${2:-1.1.0}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
export PATH="$HOME/.local/bin:/opt/node-vm/bin:/usr/local/bin:/usr/bin:/bin"
base="$HOME/.local/share/dok-dev/tool-releases"
release="$base/pi-$version"
launcher="$HOME/.local/bin/pi"
case "$action" in
  prepare)
    if [[ ! -e "$release" ]]; then
      mkdir -p "$release"
      npm view "@earendil-works/pi-coding-agent@$version" name version dist.integrity engines --json > "$release/upstream.json"
      npm install --prefix "$release" --save-exact --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@$version"
    fi
    [[ "$("$release/node_modules/.bin/pi" --version)" == "$version" ]]
    ;;
  activate)
    [[ "$("$release/node_modules/.bin/pi" --version)" == "$version" ]]
    [[ -L "$launcher" ]] || { echo 'Refusing to replace a non-symlink launcher' >&2; exit 2; }
    mkdir -p "$base/rollback"
    backup="$base/rollback/pi-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    # Save the resolved target: the existing link uses a relative path.
    readlink -f "$launcher" > "$backup.target"
    temp="$launcher.next.$$"
    trap 'rm -f -- "$temp"' EXIT
    ln -s "$release/node_modules/.bin/pi" "$temp"
    mv -Tf "$temp" "$launcher"
    printf 'Activated Pi %s; rollback target recorded at %s.target\n' "$version" "$backup"
    ;;
  status) "$launcher" --version; readlink -f "$launcher" ;;
  *) echo 'Usage: pi-release.sh prepare|activate|status [version]' >&2; exit 2 ;;
esac
