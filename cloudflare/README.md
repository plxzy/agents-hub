# Cloudflare fixture host

This is an optional static host for the public, read-only fixture demo. It has no Worker API, Durable Object, D1 database, credentials, runner binding, or task-start route.

Build it from the repository root:

```sh
npm run demo:build
```

Deploy the `cloudflare/` directory with the current Wrangler release when a public preview is wanted. The `public/index.html` file is generated and ignored by Git; the source of truth remains `ui/dashboard.html` and `demo/fixtures.mjs`.
