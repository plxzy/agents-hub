/**
 * The agents plugin inside Pi: the same operations as in Claude and Codex (ops.mjs), as an MCP server for the model
 * and an /agents command for you. It stays out of Pi processes that `agent` starts for an agent (AGENT_RUN=1), so
 * agents never get tools to start other agents or decide reviews.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const opsModule = path.join(repo, "agent-workflow/ops.mjs");
const call = async (name: string, args: Record<string, unknown> = {}) => (await import(opsModule)).callOp(name, args);

type Status = { agents: number; running: number; pending: { memory: number; proposals: number } };
type Run = { run_id: string; agent: string; status: string; task: string; started: string };
type Item = { id: string; kind: string; agent?: string; why?: string; body: string };

const firstLine = (t: string) => String(t ?? "").trim().split("\n")[0].slice(0, 70);

export default function (pi: ExtensionAPI) {
	if (process.env.AGENT_RUN === "1") return;

	pi.registerMcpServer("agents", {
		command: process.execPath,
		args: [path.join(repo, "agent-workflow/mcp.mjs")],
		description: "The user's own Pi agents: list them, delegate a task (run_agent/start_run), check runs, see what waits for review.",
	});

	const showStatus = async (ctx: { ui: { setStatus(k: string, t: string | undefined): void } }) => {
		try {
			const s: Status = await call("get_status");
			const review = s.pending.memory + s.pending.proposals;
			ctx.ui.setStatus("agents", review || s.running ? `agents: ${s.running ? `${s.running} running ` : ""}${review ? `${review} to review` : ""}`.trim() : undefined);
		} catch { /* the status line is a convenience */ }
	};
	pi.on("session_start", async (_event, ctx) => { if (ctx.hasUI) await showStatus(ctx); });

	pi.registerCommand("agents", {
		description: "Your agents: recent runs, what waits for your review (accept/reject), status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const s: Status = await call("get_status");
			const review = s.pending.memory + s.pending.proposals;
			const choice = await ctx.ui.select(`${s.agents} agents · ${s.running} running · ${review} to review`,
				["Recent runs", `Review (${review})`, "Dashboard in the browser"]);
			if (choice === "Recent runs") {
				const runs: Run[] = await call("list_runs", { limit: 15 });
				const picked = await ctx.ui.select("Recent runs (newest first)",
					[...runs].reverse().map((r) => `${r.status.padEnd(11)} ${r.agent.padEnd(9)} ${firstLine(r.task)}  ·  ${r.run_id}`));
				const id = picked?.split("·").pop()?.trim();
				if (id) {
					const r = await call("get_run", { run_id: id });
					ctx.ui.notify(`${r.agent} · ${r.status}\n${firstLine(r.task)}\n\n${String(r.output ?? r.error ?? "(no output yet)").slice(0, 1500)}`, "info");
				}
			} else if (choice?.startsWith("Review")) {
				const items: Item[] = await call("list_pending");
				if (!items.length) return ctx.ui.notify("Nothing waiting for your review.", "info");
				const picked = await ctx.ui.select("Waiting for your review",
					items.map((p) => `${p.kind.padEnd(12)} ${(p.agent ?? "").padEnd(9)} ${firstLine(p.body)}  ·  ${p.id}`));
				const item = items.find((p) => picked?.endsWith(p.id));
				if (!item) return;
				const decision = await ctx.ui.select(`${item.kind} from ${item.agent ?? "?"}${item.why ? ` (${item.why})` : ""}:\n\n${item.body}`,
					["Accept", "Reject", "Decide later"]);
				if (decision === "Accept" || decision === "Reject") {
					const reason = decision === "Reject" ? await ctx.ui.input("Reason (optional)") : undefined;
					ctx.ui.notify(await call("review_decide", { id: item.id, decision: decision.toLowerCase(), reason: reason || undefined }), "info");
					await showStatus(ctx);
				}
			} else if (choice === "Dashboard in the browser") {
				ctx.ui.notify("Run `agent ui` in a terminal: it opens the dashboard and serves it while it runs.", "info");
			}
		},
	});
}
