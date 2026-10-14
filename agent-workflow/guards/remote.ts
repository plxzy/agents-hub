/**
 * Extra guard for runs started from another app through `agent link` (AGENT_REMOTE_RUN=1). The task text came from
 * outside the Mac and the answer goes back out, so the agent may only look inside its own workspace: no shell, and
 * read/grep/find/ls must stay within the folder Pi runs in (symlinks resolved) and away from secret-looking files.
 * The macOS sandbox cannot do this alone, because Pi itself must read its own credentials.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const secrets = /(auth\.json|\.credentials|credentials\.json|\.npmrc|\.netrc|\.claude\.json|\.ssh\b|\.aws\b|\.gnupg\b|Keychains|Cookies\b|(^|[\s/'"])\.env(\.|\b)|link\.json|publish\.env|\.pem$|\.key$|id_(rsa|ed25519))/;

// A path that does not exist yet resolves through its nearest existing parent, and a dangling symlink through its
// target, so a link inside the workspace cannot point a not-yet-existing name outside it.
const real = (p: string, depth = 0): string => {
	const abs = path.resolve(p);
	try { return fs.realpathSync(abs); } catch { /* resolve below */ }
	const parent = path.dirname(abs);
	if (parent === abs || depth > 40) return abs;
	try { return real(path.resolve(parent, fs.readlinkSync(abs)), depth + 1); } catch { /* not a link */ }
	return path.join(real(parent, depth + 1), path.basename(abs));
};

/** Why a tool call is blocked in a remote run, or undefined. */
export function remoteVerdict(tool: string, input: Record<string, unknown>, cwd = process.cwd()): string | undefined {
	if (!["read", "grep", "find", "ls"].includes(tool)) return `uses ${tool}, which remote runs may not use`;
	const root = real(cwd);
	// grep's `pattern` is a regex over file contents, not a path.
	for (const key of tool === "grep" ? ["path", "glob"] : ["path", "pattern", "glob"]) {
		const value = input[key];
		if (typeof value !== "string" || !value) continue;
		if (secrets.test(value)) return "touches credentials or secrets";
		if (key !== "path" && !/^([~/]|\.\.)/.test(value) && !value.includes("/../")) continue; // a relative glob stays inside
		const abs = real(path.resolve(cwd, value.replace(/^~(?=\/|$)/, os.homedir())));
		if (abs !== root && !abs.startsWith(root + path.sep)) return `reads outside the agent's workspace (${abs})`;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
		const why = remoteVerdict(event.toolName, (event.input ?? {}) as Record<string, unknown>, cwd);
		if (!why) return undefined;
		return {
			block: true,
			reason: `Blocked by remote guard: this ${event.toolName} call ${why}. This run was started from another app; `
				+ "answer from what is inside the workspace, or tell the user what to check on the Mac themselves.",
		};
	});
}
