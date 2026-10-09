# Layer on the exact deployed image: preserves its reviewed runtime/auth changes.
# Tag the recorded immutable local image ID before building; verify its ID first.
ARG BASE_IMAGE=dok-dev:baseline-pi-20261009
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@12.2.0 @openai/codex@0.162.0 codex-multi-auth@2.19.1 \
    && npm cache clean --force
RUN curl --fail --location --retry 3 \
      https://downloads.claude.ai/claude-code-releases/2.1.295/linux-x64/claude \
      -o /usr/local/bin/claude \
    && printf '%s  %s\n' 4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358 /usr/local/bin/claude | sha256sum --check \
    && chmod 755 /usr/local/bin/claude \
    && /usr/local/bin/codex --version && claude --version && npm --version
# SSH and its direct official-Codex shim are inherited unchanged.
