# Agents runner on dok: Pi + the agent-workflow supervisor (no sshd, editors or other agent CLIs).
FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bubblewrap git python3 ca-certificates tini procps mawk \
    # The sandbox mounts /usr, but not the host's /etc/alternatives tree.
    && ln -s /usr/bin/mawk /usr/local/bin/awk \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -l agent -d /home/agent -m node && groupmod -n agent node
# Pi is pinned by its lockfile (registry integrity); lifecycle scripts never run.
COPY pi/package.json pi/package-lock.json /opt/pi/
COPY strip-codex-provider.mjs /opt/strip-codex-provider.mjs
COPY agent-healthcheck.mjs /usr/local/bin/agent-healthcheck
RUN cd /opt/pi && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force \
    && node /opt/strip-codex-provider.mjs \
    && ln -s /opt/pi/node_modules/.bin/pi /usr/local/bin/pi \
    && chmod 755 /usr/local/bin/agent-healthcheck \
    && test "$(pi --version)" = 1.2.0
# Optional private Pi extensions (named build context "extensions"; the default ./extensions is empty), e.g. an
# accounts module for extra provider logins that the runner config names as accounts_module.
COPY --from=extensions / /opt/pi-extensions/
RUN for d in /opt/pi-extensions/*/; do if test -f "$d/package.json"; then ln -s /opt/pi/node_modules "$d/node_modules"; fi; done
USER agent
WORKDIR /home/agent
ENV PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin
ENTRYPOINT ["/usr/bin/tini", "--"]
# install-workflow.sh writes this launcher for the active release.
CMD ["/home/agent/.local/bin/agent-supervisor", "/home/agent/.config/agent-workflow/dok.json"]
