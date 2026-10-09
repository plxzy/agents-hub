import { bindings, defineConfig } from "cf/config";

// HUB_NAME / HUB_ACCESS_AUD deploy a second copy (e.g. agents-hub-next) behind its own Access application.
const name = process.env.HUB_NAME ?? "agents-hub";
const accessAud = process.env.HUB_ACCESS_AUD ?? "YOUR-ACCESS-AUD";

export default defineConfig({
	worker: {
		name,
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["global_fetch_strictly_public"],
		entrypoint: "src/worker.mjs",
		env: {
			ACCESS_ISSUER: bindings.text("https://YOUR-TEAM.cloudflareaccess.com"),
			ACCESS_AUD: bindings.text(accessAud),
			STALE_AFTER_MS: bindings.text("900000"),
			DB: bindings.d1({
				name: "agent-readonly",
				id: "00000000-0000-0000-0000-000000000000",
			}),
		},
	},
});
