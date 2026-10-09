# Vendored

`ext-apps-2.0.3-app-with-deps.js` is `dist/src/app-with-deps.js` from the npm package
`@modelcontextprotocol/ext-apps@2.0.3` (published 2026-09-25), unchanged; licence in `ext-apps-LICENSE`.
It is the MCP Apps bridge (`App` class) that `ui/dashboard.mjs` inlines into the dashboard, because hosts'
iframe CSP blocks loading scripts from a CDN. Kept in the repo so the local MCP server needs no `npm install`.

sha256: `fb56376b7583ecafb4820bdebc150abee18feb6258ff84b83c2c944ebd9c3602`

To update: `npm pack @modelcontextprotocol/ext-apps@<version>` (a version at least two weeks old), copy the
file, update this note and the file name in `ui/dashboard.mjs`.
