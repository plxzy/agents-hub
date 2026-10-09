/**
 * Read-only bash guard for agents that should only observe.
 * Loaded by `agent` for agents with `guard: readonly`. Blocks, before execution, any bash command that
 * changes state, whatever the model was told or asked. Allowed sudo commands come from the agent file
 * (`sudo_allow:`), passed in AGENT_SUDO_ALLOW as a JSON array of exact command prefixes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sudoAllow: string[] = (() => {
	try { return JSON.parse(process.env.AGENT_SUDO_ALLOW ?? "[]"); } catch { return []; }
})();

// Each segment of a compound command is checked (split on ; && || | and newlines).
const changes: [RegExp, string][] = [
	[/^(sudo\s+)?(kill|killall|pkill|shutdown|reboot|halt)\b/, "stops processes or the machine"],
	[/^(sudo\s+)?(rm|rmdir|mv|cp|ln|chmod|chown|chflags|truncate|dd|mkfs|diskutil|tee)\b/, "changes files"],
	[/^(sudo\s+)?(launchctl|defaults\s+(write|delete)|systemsetup|scutil\s+--set|pmset|softwareupdate)\b/, "changes system settings"],
	[/^(sudo\s+)?networksetup\s+-(set|add|remove|create|delete|switch)/, "changes network settings"],
	[/^(sudo\s+)?(ifconfig\s+\S+\s+(up|down|alias|-alias|inet|ether|mtu)|route\s+(add|delete|change|flush))\b/, "changes interfaces or routes"],
	[/^(sudo\s+)?(dscacheutil\s+-flushcache|pfctl\s+-[edfFk])/, "changes DNS cache or firewall"],
	[/^(sudo\s+)?mullvad\s+(connect|disconnect|reconnect|relay\s+set|lockdown-mode|dns\s+set|tunnel\s+set|account|lan\s+set)/, "changes the VPN"],
	[/^(sudo\s+)?(brew|npm|pip3?|port)\s+(install|uninstall|remove|upgrade)/, "installs software"],
	[/^(sudo\s+)?(curl|wget)\b.*\s(-o|-O|--output)\b/, "downloads files"],
];

function segments(command: string): string[] {
	return command.split(/;|&&|\|\||\||\n/).map((s) => s.trim()).filter(Boolean);
}

export function verdict(command: string): string | undefined {
	// Writing to files via redirection (anything but /dev/null or fd duplication).
	if (/(^|[^0-9&])>{1,2}\s*(?!\/dev\/null|&)\S/.test(command.replace(/\d?>\s*\/dev\/null/g, ""))) return "writes to a file";
	for (const seg of segments(command)) {
		if (/^sudo\b/.test(seg) && !sudoAllow.some((p) => seg.startsWith(p))) return "uses sudo outside the allowed commands";
		for (const [re, why] of changes) if (re.test(seg)) return why;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const why = verdict(String(event.input.command ?? ""));
		if (!why) return undefined;
		return {
			block: true,
			reason: `Blocked by read-only guard: this command ${why}. You only observe. Give the user the exact command to run themselves instead.`,
		};
	});
}
