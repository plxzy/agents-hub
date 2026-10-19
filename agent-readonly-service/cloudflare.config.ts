import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindings, defineConfig, exports } from "cf/config";

// Deployment values live outside the repo: HUB_CONFIG (default ~/.config/agents-hub/hub.json), see hub.example.json.
// A missing file stops the build so a deploy can never bind placeholders; HUB_LOCAL=1 allows them for `cf dev`.
const configPath = process.env.HUB_CONFIG ?? path.join(os.homedir(), ".config/agents-hub/hub.json");
const file = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
if (!file && process.env.HUB_LOCAL !== "1") {
	throw new Error(`Hub config not found at ${configPath}: copy hub.example.json there (or set HUB_CONFIG), or set HUB_LOCAL=1 for local placeholders.`);
}

// HUB_NAME / HUB_ACCESS_AUD deploy a second copy (e.g. agents-hub-next) behind its own Access application.
const name = process.env.HUB_NAME ?? file?.name ?? "agents-hub";
const accessIssuer = process.env.HUB_ACCESS_ISSUER ?? file?.accessIssuer ?? "https://example.cloudflareaccess.com";
const accessAud = process.env.HUB_ACCESS_AUD ?? file?.accessAud ?? "";
const d1 = { name: file?.d1?.name ?? "agents-hub", id: file?.d1?.id ?? "00000000-0000-0000-0000-000000000000" };
const r2Bucket = file?.r2Bucket ?? "agents-hub-run-artifacts";

export default defineConfig({
	worker: {
		name,
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["global_fetch_strictly_public"],
		// Run near D1 and the runner's Durable Object instead of near the caller: a panel read makes many D1 round trips.
		placement: { mode: "smart" },
		entrypoint: "src/worker.mjs",
		exports: { AgentRelay: exports.durableObject({ storage: "sqlite" }) },
		env: {
			RELAY: bindings.durableObject({ worker: name, exportName: "AgentRelay" }),
			ACCESS_ISSUER: bindings.text(accessIssuer),
			ACCESS_AUD: bindings.text(accessAud),
			DEVELOPMENT_ENABLED: bindings.text(process.env.HUB_DEVELOPMENT_ENABLED ?? String(file?.developmentEnabled ?? true)),
			// Off unless set: lists submit_vm_control and get_vm_control. The runner's own enrollment and grants still decide (plxzy/vm#806).
			VM_CONTROL_ENABLED: bindings.text(process.env.HUB_VM_CONTROL_ENABLED ?? String(file?.vmControlEnabled ?? false)),
			DB: bindings.d1(d1),
			RUN_ARTIFACTS: bindings.r2({ name: r2Bucket }),
		},
	},
});
