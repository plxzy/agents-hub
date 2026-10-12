# Agents runner on dok: Pi + the agent-workflow supervisor, nothing else (no sshd, no editors, no other CLIs).
FROM node:26.10.0-bookworm-slim@sha256:3ffc19ea878019d9e9ae8971732ad4a03cda44f167107173174b60ed7c65bed3
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bubblewrap git python3 ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -l agent -d /home/agent -m node && groupmod -n agent node
# Pi is pinned by its lockfile (registry integrity); lifecycle scripts never run.
COPY pi/package.json pi/package-lock.json /opt/pi/
RUN cd /opt/pi && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force \
    && ln -s /opt/pi/node_modules/.bin/pi /usr/local/bin/pi && test "$(pi --version)" = 1.1.0
# OpenAI account slots (openai-2, openai-3, ...): loaded by interactive Pi for /login and by the run worker.
COPY pi-openai-accounts /opt/pi-openai-accounts
RUN ln -s /opt/pi/node_modules /opt/pi-openai-accounts/node_modules \
    && node -e "import('/opt/pi-openai-accounts/index.ts').then(m => { if (typeof m.accountProvider !== 'function') process.exit(1); })"
USER agent
WORKDIR /home/agent
ENV PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin
ENTRYPOINT ["/usr/bin/tini", "--"]
# install-workflow.sh writes this launcher for the active release.
CMD ["/home/agent/.local/bin/agent-supervisor", "/home/agent/.config/agent-workflow/dok.json"]
