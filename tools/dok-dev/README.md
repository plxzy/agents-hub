# dok-dev development environment

`pi-release.sh` runs as `vscode` inside dok-dev. `prepare 1.1.0` installs a pinned
candidate with npm lifecycle scripts disabled and records registry integrity and
the resolved dependency lock. `activate 1.1.0` atomically changes only the Pi
launcher symlink. Existing processes, authentication and session files are untouched.

Rollback: read the selected private `tool-releases/rollback/pi-*.target`, create
a temporary symlink to that absolute target, then atomically replace
`~/.local/bin/pi`. Keep both release directories; do not uninstall the old package.

The container image and persistent user tooling are separate rollback units.
Candidate images must use isolated writable state. A production relay must never
be started as part of candidate verification.
