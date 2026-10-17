FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/workflow
COPY agent-workflow/run-artifact-contract.mjs agent-workflow/run-artifact-contract.mjs
COPY agent-workflow/run-continuation.mjs agent-workflow/run-continuation.mjs
COPY tools/review-publisher tools/review-publisher
# Public application files must be readable even when the build context uses a private umask.
RUN chmod -R a+rX /opt/workflow
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "tools/review-publisher/server.mjs", "/config/publisher.json"]
