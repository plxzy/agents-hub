# agents runner on dok

The always-on runner for Agents Hub: one small container (`agents`, user `agent`) whose main process is the
agent-workflow supervisor (`dev-supervisor.mjs`). Docker restarts it; there is no systemd unit and no `docker exec`
wrapper. It replaced the supervisor that ran inside the vm project's `dok-dev` devcontainer (user `vscode`) on
2026-10-12; `dok-dev` itself is untouched.

| What | Where (inside the `agents-home` volume) |
|---|---|
| Pi login (your own `/login`, never copied) | `~/.pi/agent/auth.json` |
| Supervisor config (endpoint, machine token, paths; mode 600) | `~/.config/agent-workflow/dok.json` |
| Released code (`install-workflow.sh`) | `~/.local/share/agent-workflow/releases/<rev>`, launchers in `~/.local/bin` |
| Reviewed knowledge / dated context | `~/.local/share/agent-workflow/{knowledge,context}/` |
| Bare repo (`main` + append-only review refs) | `~/repos/dev-workflow.git` |
| Runs, sessions, receipts | `~/.local/state/dok-agent/` |

Files here are copied to `dok:~/agents-runner/`. Pi is pinned by `pi/package-lock.json`; the base image by digest.

```sh
# on dok
cd ~/agents-runner && docker compose build
docker compose up -d                     # start / restart the supervisor
docker logs -f agents                    # "dok-dev linked to Agents Hub."
# from the Mac
ssh -t dok docker exec -it agents pi     # interactive Pi (e.g. /login); paste the redirect URL when asked
ssh -t dok docker exec -it agents agent chat workflow
git push dok main:main                   # remote "dok" uses docker exec git-receive-pack (see below)
```

Mac remote: `git remote set-url dok dok:/home/agent/repos/dev-workflow.git` with
`remote.dok.receivepack = docker exec -i agents git-receive-pack` and
`remote.dok.uploadpack = docker exec -i agents git-upload-pack`.

Upgrade: `install.sh <revision>` (archives that commit from the bare repo, installs it, restarts the container).
Rollback: `install.sh <previous revision>`. Never run a second supervisor against the same Hub owner: starting one
replaces the other's connection.
