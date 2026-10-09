# Agents Hub

Agents Hub is a small dashboard and data contract for inspecting agent runs, progress, and review state across local and remote runners.

This repository is the public, reusable part of a larger private setup. It contains the read-only contract, the dashboard renderer, sanitisation helpers, and a fixture-backed demo. Private runner hosts, provider sessions, credentials, personal prompts, repositories, and deployment configuration stay outside this repository.

## Run the fixture demo

```sh
npm install
npm test
npm run demo
```

Open the address printed by the demo server. The demo is read-only and uses deterministic sample data. It cannot start an agent, access a runner, or send data to a provider.

## What is public here

- A plain JavaScript data contract shared by dashboard surfaces.
- A progressively enhanced dashboard that works with a host bridge or the fixture demo bridge.
- Bounded run-progress, failure, recovery, and trace formatting.
- Tests and sample data that make the read-only behavior reproducible.

## What is deliberately absent

The private deployment, runner hosts, provider authentication, personal agent definitions and memory, live task history, repository allowlists, and production Cloudflare bindings are not part of this package. The optional Cloudflare adapter serves the same fixture mode; it is not a connection to a private runner.

## History

The commit history is a curated export of development milestones from the private implementation. It preserves the order and dates of public-safe milestones where useful, while rewriting paths and removing private infrastructure details. The export was made public only after this boundary review.

## License

MIT. The vendored MCP Apps bridge retains its upstream license in `ui/vendor/ext-apps-LICENSE`.
