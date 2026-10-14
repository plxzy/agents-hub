# Cloudflare fixture host

This is an optional static host for the public, read-only fixture demo. It has no Worker API, Durable Object, D1 database, credentials, runner binding, or task-start route.

Build and deploy it from the repository root with the Cloudflare `cf` CLI (`cloudflare.config.ts`, `vite.config.ts`):

```sh
npm run demo:deploy
```

`npm run demo:build` alone writes the page without deploying. The `public/index.html` file is generated and ignored by Git; the source of truth remains `ui/dashboard.html` and `demo/fixtures.mjs`.
