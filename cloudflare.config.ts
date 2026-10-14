import { defineConfig } from "cf/config";

// Static fixture demo only: no bindings and no API routes.
export default defineConfig({
	worker: {
		name: "agents-hub-public-demo",
		compatibilityDate: "2026-10-13",
		entrypoint: "cloudflare/worker.mjs",
	},
});
