# Agents runner on dok: Pi + the agent-workflow supervisor (no sshd, editors or other agent CLIs).
# python-build compiles the pinned CPython the sandboxes expose as python3; the final stage keeps only /opt/python.
FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS python-build
SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl xz-utils libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
      libffi-dev liblzma-dev libgdbm-dev uuid-dev \
    && curl --fail --show-error --silent --location --connect-timeout 20 --max-time 300 \
      https://www.python.org/ftp/python/3.14.8/Python-3.14.8.tar.xz -o /tmp/python.tar.xz \
    && printf '%s\n' 'c2215904f02b175596dc49351585104f4bc20341e1c47378b26a2c274360ce73  /tmp/python.tar.xz' | sha256sum --check - \
    && mkdir /tmp/python && tar -xJf /tmp/python.tar.xz -C /tmp/python --strip-components=1 \
    && cd /tmp/python && ./configure --prefix=/opt/python --with-ensurepip=install --disable-test-modules \
    && make -j"$(nproc)" && make install \
    && test "$(/opt/python/bin/python3 --version)" = 'Python 3.14.8'

FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4
COPY --from=python-build /opt/python /opt/python
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bubblewrap git python3 ca-certificates tini procps mawk \
    # The sandbox mounts /usr, but not the host's /etc/alternatives tree.
    && ln -s /usr/bin/mawk /usr/local/bin/awk \
    # The agent's python3 is the pinned build under /opt/python (the sandbox PATH starts with /usr/local/bin);
    # Debian's python3.13 stays at /usr/bin/python3 for the supervisor's internal /usr/bin/python3 calls.
    && ln -s /opt/python/bin/python3.14 /usr/local/bin/python3 \
    && ln -s /opt/python/bin/python3.14 /usr/local/bin/python3.14 \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -l agent -d /home/agent -m node && groupmod -n agent node
RUN test "$(python3 --version)" = 'Python 3.14.8' \
    && python3 -c 'import bz2, ctypes, hashlib, lzma, readline, socket, sqlite3, ssl, uuid, venv' \
    && test "$(/usr/bin/python3 --version)" != "$(python3 --version)"
# npm is pinned independently of the Node image.
RUN npm install --global npm@12.2.0 --ignore-scripts --no-audit --no-fund && npm cache clean --force
# Pi is pinned by its lockfile (registry integrity); lifecycle scripts never run.
COPY pi/package.json pi/package-lock.json /opt/pi/
COPY strip-codex-provider.mjs /opt/strip-codex-provider.mjs
COPY agent-healthcheck.mjs /usr/local/bin/agent-healthcheck
RUN cd /opt/pi && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force \
    && node /opt/strip-codex-provider.mjs \
    && ln -s /opt/pi/node_modules/.bin/pi /usr/local/bin/pi \
    && chmod 755 /usr/local/bin/agent-healthcheck \
    && test "$(pi --version)" = 1.3.0
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
