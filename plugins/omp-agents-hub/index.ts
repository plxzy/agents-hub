/**
 * omp extension: a widget below the input box with the Agents Hub runs that are running or just finished
 * (agent, status, elapsed time, PR number and progress), hidden when there are none. It reads the snapshot
 * the Tern plugin writes, and follows runs this session started through the Agents MCP server.
 * `/hub-widget` turns it off and on (omp's own `/hub` opens its built-in hub); the choice is saved for later sessions.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type Run = {
	id: string;
	agent: string;
	status: string;
	started?: number;
	ended?: number;
	pr?: number;
	step?: string;
	publication?: { status?: string; pr_number?: number; pr_url?: string };
	output?: string;
	error?: string;
};
type Snapshot = { updated?: number; runs?: Array<Partial<Run> & { run_id?: string; key?: string }> };
type ToolResult = {
	toolName?: string;
	input?: Record<string, unknown>;
	content?: Array<{ type?: string; text?: string }>;
	details?: { structuredContent?: unknown };
};

const KV = join(process.env.TERN_CONFIG_DIR ?? join(homedir(), "Library/Application Support/Tern"), "plugin-data/agents-hub/kv.json");
const OFF = join(homedir(), ".config/agents-hub/omp-widget-off"); // exists = widget turned off
const RECENT_S = 10 * 60; // finished runs stay this long
const STALE_S = 5 * 60; // hide other runs when Tern has stopped polling
// run_agent is left out: it blocks until the run ends and already returns the answer to the conversation.
const START_OPS: Record<string, true> = { start_run: true, start_selected_run: true };
// A transient "unknown" status is not an end.
const TERMINAL = (status: string) => status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

function epoch(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function duration(started: number | undefined, ended: number | undefined, now: number): string {
	const seconds = Math.max(0, (ended ?? now) - (started ?? now));
	return seconds < 3600
		? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
		: `${(seconds / 3600).toFixed(1)}h`;
}

function step(progress: unknown): string | undefined {
	if (!progress || typeof progress !== "object") return undefined;
	const record = progress as Record<string, unknown>;
	const value = record.action ?? record.phase;
	if (typeof value !== "string" || !value) return undefined;
	return value.replace(/_/g, " ").slice(0, 40);
}

function toolOperation(toolName: string | undefined): string | undefined {
	if (!toolName?.startsWith("mcp__agents")) return undefined;
	for (const op of Object.keys(START_OPS)) {
		if (toolName.endsWith(`_${op}`) || toolName.endsWith(`__${op}`)) return op;
	}
	return undefined;
}

function jsonValues(value: unknown): unknown[] {
	if (typeof value !== "string") return [value];
	const values: unknown[] = [value];
	try {
		values.push(JSON.parse(value));
	} catch {
		// MCP text may include a human-readable answer around the JSON.
	}
	return values;
}

function findRunId(value: unknown): string | undefined {
	for (const item of jsonValues(value)) {
		if (item && typeof item === "object") {
			const record = item as Record<string, unknown>;
			const id = record.run_id;
			if (typeof id === "string" && id) return id;
			for (const child of Object.values(record)) {
				const nested = findRunId(child);
				if (nested) return nested;
			}
		} else if (typeof item === "string") {
			const match = item.match(/(?:^|\s|—)run\s+([A-Za-z0-9_-]+)/);
			if (match) return match[1];
		}
	}
	return undefined;
}

function parseRun(value: unknown, fallback: Run): Run {
	const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const publication = data.publication && typeof data.publication === "object"
		? data.publication as Run["publication"]
		: fallback.publication;
	const pr = typeof data.pr === "number" ? data.pr
		: typeof publication?.pr_number === "number" ? publication.pr_number
			: fallback.pr;
	return {
		...fallback,
		agent: typeof data.agent === "string" ? data.agent : fallback.agent,
		status: typeof data.status === "string" ? data.status : fallback.status,
		started: epoch(data.started) ?? fallback.started,
		ended: epoch(data.ended) ?? fallback.ended,
		...(pr !== undefined ? { pr } : {}),
		...(publication ? { publication } : {}),
		...(typeof data.output === "string" ? { output: data.output } : {}),
		...(typeof data.error === "string" ? { error: data.error } : {}),
		step: step(data.progress) ?? fallback.step,
	};
}

function snapshotRuns(now: number): Run[] {
	try {
		const snapshot = JSON.parse(readFileSync(KV, "utf8")).snapshot as Snapshot | undefined;
		if (!snapshot?.runs || now - (snapshot.updated ?? 0) > STALE_S) return [];
		return snapshot.runs.flatMap((raw) => {
			const id = raw.id ?? raw.run_id ?? raw.key;
			if (typeof id !== "string" || !id) return [];
			return [{
				id,
				agent: typeof raw.agent === "string" ? raw.agent : "?",
				status: typeof raw.status === "string" ? raw.status : "?",
				started: epoch(raw.started),
				ended: epoch(raw.ended),
				...(typeof raw.pr === "number" ? { pr: raw.pr } : {}),
				...(typeof raw.step === "string" ? { step: raw.step } : {}),
			}];
		});
	} catch {
		return [];
	}
}

function lines(now: number, own: Map<string, Run>): string[] | undefined {
	const merged = new Map(snapshotRuns(now).map((run) => [run.id, run]));
	for (const run of own.values()) merged.set(run.id, run);
	const shown = [...merged.values()]
		.filter((run) => run.status === "running" || (run.ended !== undefined && now - run.ended < RECENT_S))
		.map((run) => {
			const took = `  ${duration(run.started, run.ended, now)}`;
			return `Hub  ${run.agent}  ${run.status}${took}${run.pr ? `  PR #${run.pr}` : ""}${run.status === "running" && run.step ? `  · ${run.step}` : ""}`;
		});
	return shown.length ? shown : undefined;
}

function excerpt(run: Run): string {
	const text = (run.output || run.error || "No output recorded").replace(/\s+/g, " ").trim();
	return text.length > 600 ? `${text.slice(0, 597)}…` : text;
}

function report(pi: ExtensionAPI, run: Run, now: number): void {
	const publication = run.publication;
	const pr = publication?.status === "published"
		? publication.pr_url ?? (publication.pr_number ? `PR #${publication.pr_number}` : undefined)
		: run.pr ? `PR #${run.pr}` : undefined;
	const details = [
		`Agents Hub run ${run.agent} ${run.status}`,
		`(${duration(run.started, run.ended, now)})`,
		pr ? `· ${pr}` : "",
		`— ${excerpt(run)}`,
	].filter(Boolean).join(" ");
	// The payload is structurally the documented CustomMessagePayload; use the API's parameter type at this boundary.
	const message = { customType: "agents-hub-run", content: details, display: true } as Parameters<ExtensionAPI["sendMessage"]>[0];
	pi.sendMessage(message, {
		triggerTurn: true,
		deliverAs: "aside",
	});
}

export default function (pi: ExtensionAPI) {
	if (process.env.AGENT_RUN === "1") return;
	const own = new Map<string, Run & { inFlight?: boolean; reported?: boolean }>();
	let draw = () => {};
	let hasUI = false;

	const poll = async (run: Run & { inFlight?: boolean; reported?: boolean }) => {
		if (run.inFlight || TERMINAL(run.status)) return;
		run.inFlight = true;
		try {
			const result = await pi.exec("agent", ["call", "get_run", JSON.stringify({ run_id: run.id })], { timeout: 15000 });
			let data: unknown;
			try {
				data = JSON.parse(result.stdout.trim());
			} catch {
				data = { status: result.code === 0 ? run.status : "failed", error: result.stderr || result.stdout };
			}
			const next = parseRun(data, run);
			Object.assign(run, next);
			if (TERMINAL(run.status) && !run.reported) {
				run.reported = true;
				if (hasUI) report(pi, run, Math.floor(Date.now() / 1000));
			}
			draw();
		} finally {
			run.inFlight = false;
		}
	};

	pi.registerCommand("hub-widget", {
		description: "Show or hide the Agents Hub runs widget",
		handler: async (_args, ctx) => {
			const on = existsSync(OFF);
			if (on) rmSync(OFF);
			else {
				mkdirSync(dirname(OFF), { recursive: true });
				writeFileSync(OFF, "");
			}
			draw();
			ctx.ui.notify(on ? "Agents Hub widget on" : "Agents Hub widget off");
		},
	});

	pi.on("tool_result", (event, ctx) => {
		if (!hasUI || !ctx.hasUI) return;
		if (!toolOperation(event.toolName)) return;
		const result = event as ToolResult;
		const values = [
			result.details?.structuredContent,
			...(result.content ?? []).filter((item) => item.type === "text").map((item) => item.text),
		];
		const id = values.map(findRunId).find(Boolean);
		if (!id) return;
		const fallback: Run & { inFlight?: boolean; reported?: boolean } = {
			id,
			agent: typeof result.input?.agent === "string" ? result.input.agent : "?",
			status: "running",
			started: Math.floor(Date.now() / 1000),
		};
		const run = own.get(id) ?? fallback;
		own.set(id, run);
		for (const value of values) Object.assign(run, parseRun(value, run));
		void poll(run);
		draw();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		hasUI = true;
		let last = "";
		draw = () => {
			const next = existsSync(OFF) ? undefined : lines(Math.floor(Date.now() / 1000), own);
			const serialized = JSON.stringify(next);
			if (serialized === last) return;
			last = serialized;
			ctx.ui.setWidget("agents-hub", next, { placement: "belowEditor" });
		};
		draw();
		ctx.setInterval(() => {
			draw();
			for (const run of own.values()) void poll(run);
		}, 5000);
	});
}
