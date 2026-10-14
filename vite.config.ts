import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { dashboardHtml } from "./ui/dashboard.mjs";
import { fixtures } from "./demo/fixtures.mjs";

// The read-only fixture page is the demo's only static asset; it is built from the same sources as `npm run demo`.
function fixturePage(): Plugin {
	return {
		name: "agents-hub-fixture-page",
		applyToEnvironment: (environment) => environment.name === "client",
		async generateBundle() { this.emitFile({ type: "asset", fileName: "index.html", source: await dashboardHtml(fixtures) }); },
	};
}

// publicDir gives the build a client environment, which is where the page is emitted.
export default defineConfig({ publicDir: "cloudflare/public", plugins: [fixturePage(), cloudflare()] });
