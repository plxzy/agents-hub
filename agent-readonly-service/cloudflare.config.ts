import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "agents-hub",
		compatibilityDate: "2026-10-01",
		entrypoint: "src/worker.mjs",
		env: {
			STALE_AFTER_MS: bindings.text("900000"),
			DB: bindings.d1({
				name: "agent-readonly",
				id: "00000000-0000-0000-0000-000000000000",
			}),
			OAUTH_KV: bindings.kv({
				id: "KV-NAMESPACE-ID",
			}),
		},
	},
});
