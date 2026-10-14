FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/workflow
COPY agent-workflow/run-artifact-contract.mjs agent-workflow/run-artifact-contract.mjs
COPY tools/review-publisher tools/review-publisher
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "tools/review-publisher/server.mjs", "/config/publisher.json"]
