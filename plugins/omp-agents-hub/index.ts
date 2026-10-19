/**
 * omp extension: a widget above the input box with the Agents Hub runs that are running or just finished
 * (agent, status, elapsed time, PR number), hidden when there are none. It reads the snapshot the Tern plugin
 * `tern-agents-hub` writes on every poll, so it starts no poll of its own; outside Tern it shows nothing.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type Run = { agent: string; status: string; started?: number; ended?: number; pr?: number };

const KV = join(process.env.TERN_CONFIG_DIR ?? join(homedir(), "Library/Application Support/Tern"), "plugin-data/agents-hub/kv.json");
const RECENT_S = 10 * 60; // finished runs stay this long
const STALE_S = 5 * 60; // the plugin polls at least every minute while Tern runs

function lines(now: number): string[] | undefined {
	let snapshot: { updated?: number; runs?: Run[] } | undefined;
	try {
		snapshot = JSON.parse(readFileSync(KV, "utf8")).snapshot;
	} catch {
		return undefined;
	}
	if (!snapshot?.runs || now - (snapshot.updated ?? 0) > STALE_S) return undefined;
	const shown = snapshot.runs
		.filter((run) => run.status === "running" || (run.ended !== undefined && now - run.ended < RECENT_S))
		.map((run) => {
			const s = Math.max(0, (run.ended ?? now) - (run.started ?? now));
			const took = run.started === undefined ? "" : s < 3600 ? `  ${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `  ${(s / 3600).toFixed(1)}h`;
			return `Hub  ${run.agent}  ${run.status}${took}${run.pr ? `  PR #${run.pr}` : ""}`;
		});
	return shown.length ? shown : undefined;
}

export default function (pi: ExtensionAPI) {
	if (process.env.AGENT_RUN === "1") return;
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		let last = "";
		const draw = () => {
			const next = lines(Math.floor(Date.now() / 1000));
			if (JSON.stringify(next) === last) return;
			last = JSON.stringify(next);
			ctx.ui.setWidget("agents-hub", next);
		};
		draw();
		ctx.setInterval(draw, 5000);
	});
}
