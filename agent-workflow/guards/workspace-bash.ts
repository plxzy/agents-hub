/**
 * Guard for agents that develop: they may edit, run tests and commit inside their workspace, but not
 * touch the machine, credentials, or the user's own decisions. Loaded by `agent` for `guard: workspace`.
 *
 * The hard write boundary is the macOS sandbox `agent` starts Pi in (`write_paths`); this guard adds what
 * a sandbox cannot express and explains the block to the model. Protected paths (accepted memory, the
 * agent's own definition, …) come from AGENT_PROTECTED as a JSON array of absolute path prefixes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";

const protectedPaths: string[] = (() => {
	try { return JSON.parse(process.env.AGENT_PROTECTED ?? "[]"); } catch { return []; }
})();

const secrets = /(auth\.json|agent-readonly\/publish\.env|openai-accounts\.json|multi-auth|\.credentials|credentials\.json|\/\.ssh\b|\/\.aws\b|\/\.netrc|Keychains|\/Cookies\b|(^|[\s/'"])\.env(\.|\b)|security\s+(find-\w+-password|dump-keychain|export))/;

// Checked per segment of a compound command (split on ; && || | and newlines).
const forbidden: [RegExp, string][] = [
	[/^sudo\b/, "uses sudo"],
	[/^(kill|killall|pkill|shutdown|reboot|halt)\b/, "stops processes or the machine"],
	[/^(launchctl|defaults\s+(write|delete)|systemsetup|scutil\s+--set|pmset|softwareupdate|networksetup|diskutil|mullvad\s+(?!status))/, "changes system or network settings"],
	[/^(brew|pip3?|port)\s+(install|uninstall|remove|upgrade)|^npm\s+(install|i|uninstall)\s+(.*\s)?(-g|--global)\b/, "installs software outside the project"],
	[/^git\s+(push|reset\s+--hard|clean\b|filter-branch|filter-repo|rebase|stash\s+(drop|clear)|branch\s+-D|checkout\s+--\s|.*--force\b)/, "rewrites or discards git history or work"],
	[/^(\S*\/)?agent\s+(memory|feedback)\b|^(\S*\/)?agent\s+review\s+(accept|reject)\b/, "makes a decision that belongs to the user (ratings, memory, reviews)"],
	[/^(\S*\/)?(claude|codex)\s+mcp\s+(add|remove)/, "changes another app's configuration"],
];

const fileChanging = /^(rm|rmdir|mv|cp|ln|chmod|chown|truncate|touch|tee|mkdir|sed\s+(-\S*i|--in-place)|perl\s+-\S*i)\b/;

function segments(command: string): string[] {
	return command.split(/;|&&|\|\||\||\n/).map((s) => s.trim()).filter(Boolean);
}

const expand = (p: string, cwd: string) => {
	const s = p.replace(/^['"]|['"]$/g, "");
	return path.resolve(cwd, s === "~" ? os.homedir() : s.startsWith("~/") ? path.join(os.homedir(), s.slice(2)) : s.replace(/^\$HOME/, os.homedir()));
};
const isProtected = (abs: string) => protectedPaths.some((p) => abs === p || abs.startsWith(p.endsWith("/") ? p : p + "/"));

/** Why a bash command is blocked, or undefined. `cwd` is where Pi runs it. */
export function verdict(command: string, cwd = process.cwd()): string | undefined {
	if (secrets.test(command)) return "touches credentials or secrets";
	let dir = cwd;
	for (const seg of segments(command)) {
		const cd = /^cd\s+(\S+)/.exec(seg);
		if (cd) { dir = expand(cd[1], dir); continue; }
		for (const [re, why] of forbidden) if (re.test(seg)) return why;
		const targets = [...seg.matchAll(/(?:^|[^0-9&<])>{1,2}\s*([^\s;&|]+)/g)].map((m) => m[1]);
		if (fileChanging.test(seg)) targets.push(...seg.split(/\s+/).slice(1).filter((t) => !t.startsWith("-")));
		const hit = targets.map((t) => expand(t, dir)).find(isProtected);
		if (hit) return `changes a protected path (${hit})`;
	}
	return undefined;
}

/** Why a read/edit/write/grep/find/ls call is blocked, or undefined. */
export function pathVerdict(tool: string, file: string, cwd = process.cwd()): string | undefined {
	if (secrets.test(file)) return "touches credentials or secrets";
	if ((tool === "edit" || tool === "write") && isProtected(expand(file, cwd))) return `changes a protected path (${expand(file, cwd)})`;
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
		const input = event.input as Record<string, unknown>;
		const why = event.toolName === "bash"
			? verdict(String(input.command ?? ""), cwd)
			: pathVerdict(event.toolName, String(input.path ?? input.pattern ?? ""), cwd);
		if (!why) return undefined;
		return {
			block: true,
			reason: `Blocked by workspace guard: this ${event.toolName} call ${why}. Do not try another way around it. `
				+ "If it is needed, tell the user what to do and why, or write a proposal for them to review.",
		};
	});
}
