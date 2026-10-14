#!/usr/bin/env bash
# On dok, as the host user: install a committed agent-workflow revision into the runner and restart it.
set -euo pipefail
rev=${1:?usage: install.sh REVISION [KNOWLEDGE_DIR_NAME]}
# The code comes from the public repository (AGENTS_SOURCE in .env overrides it); dok keeps a bare mirror in the home volume.
source_url=${AGENTS_SOURCE:-$(sed -n 's/^AGENTS_SOURCE=//p' "$(dirname "$0")/.env" 2>/dev/null)}
source_url=${source_url:-https://github.com/plxzy/agents-hub.git}
# Admission is closed atomically by the live supervisor before release activation.
# Older releases without control.sock require a verified idle cutover by the operator.
if test -n "$(docker ps -q --filter name=^agents$)"; then
  docker exec agents /home/agent/.local/bin/agent-supervisor --drain /home/agent/.config/agent-workflow/dok.json
  trap 'docker exec agents /home/agent/.local/bin/agent-supervisor --undrain /home/agent/.config/agent-workflow/dok.json >/dev/null 2>&1 || true' EXIT
fi
knowledge=${2:-$(docker run --rm --entrypoint sh -v agents-home:/home/agent agents-runner:pi-1.1.0 -c 'basename "$(python3 -c "import json;print(json.load(open(\"/home/agent/.config/agent-workflow/dok.json\"))[\"knowledge\"])")"')}
cd "$(dirname "$0")"
docker compose run --rm --no-deps --entrypoint bash runner -lc "set -e
  R=/home/agent/repos/agents-hub.git; T=\$(mktemp)
  test -d \$R || git init -q --bare \$R
  git --git-dir=\$R fetch -q --prune $source_url '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
  git --git-dir=\$R show $rev:tools/dok-dev/install-workflow.sh > \$T
  bash \$T \$R /home/agent/.local/share/agent-workflow/knowledge/$knowledge $rev /home/agent/.local/share/agent-workflow/context/current
  rm \$T
  python3 - <<'PY'
import json, os, subprocess
p = '/home/agent/.config/agent-workflow/dok.json'
c = json.load(open(p))
c['revision'] = subprocess.check_output(['git', '--git-dir=/home/agent/repos/agents-hub.git', 'rev-parse', '$rev^{commit}'], text=True).strip()
c['knowledge'] = '/home/agent/.local/share/agent-workflow/knowledge/$knowledge'
t = p + '.new'; fd = os.open(t, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, (json.dumps(c, indent=2) + '\n').encode()); os.close(fd); os.replace(t, p)
print('dok.json revision', c['revision'][:12], 'knowledge', '$knowledge')
PY"
# Restart only an already running runner; the first start is a separate, deliberate cutover.
if test -n "$(docker ps -q --filter name=^agents$)"; then docker compose up -d --force-recreate; else echo 'Runner not running; start it with: docker compose up -d'; fi
