# Read-only agent service

This service publishes a sanitized view of the local `agent-workflow` state for hosted ChatGPT conversations and Dots. Local Pi remains the execution owner. It uses the `cf` CLI and `@cloudflare/vite-plugin`; the old Wrangler config is no longer used.

Run the contract tests with `npm test`. Build a snapshot locally with:

```sh
node -e "import('./publisher.mjs').then(async ({buildSnapshot}) => console.log(JSON.stringify(await buildSnapshot(), null, 2)))"
```

The Worker exposes authenticated `GET /v1/agents`, `GET /v1/agents/:name`, `GET /v1/runs`, `GET /v1/runs/:id`, and `GET /v1/context`. The only write endpoint is the publisher's authenticated `POST /v1/snapshots`; hosted clients cannot execute agents or mutate memory, Pages, or Dots.

Before deployment, apply the migration with `cf d1 migrations apply` using the database ID in `cloudflare.config.ts`, and set `READ_TOKEN` and `PUBLISH_TOKEN` as Worker secrets. The deployed read-only endpoint is `https://agent-readonly.YOUR-ACCOUNT.workers.dev`. Live ChatGPT/Dot wiring is intentionally not claimed by local tests; it requires host-specific authenticated acceptance after deployment.
