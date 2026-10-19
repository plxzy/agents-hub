--!strict
-- The window half: a palette command and a key bind that open the Agents Hub
-- panel (or focus the one already open), and a status-line segment read from
-- the `snapshot` the host's poller writes to `tern.kv`.

local KIND = "agents-hub.panel"
local ACTION = "plugin.agents-hub.open"

local function open_panel(cx: WindowCx)
	-- One panel per window is enough.
	for _, pane in cx.session:panes() do
		if string.sub(pane.title, 1, #"Agents Hub") == "Agents Hub" then
			cx.layout:focus(pane.pane)
			return
		end
	end
	if cx:new_block(KIND, nil, "beside") == nil then
		cx:toast("error", "Agents Hub is not loaded on this host", "Install the plugin where your panes run.")
	end
end

tern.command({
	id = "open",
	title = "Agents Hub",
	icon = "bot",
	run = open_panel,
})

tern.bind(if tern.runtime.os == "macos" then "cmd+alt+shift+h" else "ctrl+alt+shift+h", ACTION)

local function snapshot(): any
	local ok, snap = pcall(tern.kv.get, "snapshot")
	return if ok and type(snap) == "table" then snap else nil
end

-- `Hub 1 running · 3 to review`; nothing when there is nothing to report.
tern.chrome.status(function(_pane: StatusPaneInfo): { StatusSegment }?
	local snap = snapshot()
	if not snap then
		return nil
	end
	local parts = {}
	if snap.problem then
		table.insert(parts, "unreachable")
	end
	if (snap.running or 0) > 0 then
		table.insert(parts, snap.running .. " running")
	end
	if (snap.review or 0) > 0 then
		table.insert(parts, snap.review .. " to review")
	end
	if not snap.problem and snap.runner and not snap.online then
		table.insert(parts, snap.runner .. " offline")
	end
	if #parts == 0 then
		return nil
	end
	return { { text = "Hub " .. table.concat(parts, " · "), icon = "bot", tone = if snap.problem then "error" else nil, command = ACTION } }
end)

-- Redraw when the host wrote a new snapshot and notify once for each terminal
-- run event. The host omits events from its initial terminal-only poll.
local seen: { [string]: boolean } = {}
local notifications_ready = false
local seen_updated: number? = nil
local function watch()
	tern.timer(5000, function(cx: WindowCx?)
		local snap = snapshot()
		if snap and snap.updated ~= seen_updated then
			seen_updated = snap.updated
			if type(snap.notifications) == "table" then
				for _, notice in snap.notifications do
					if type(notice) == "table" and type(notice.id) == "string" then
						if notifications_ready and cx and not seen[notice.id] then
							local pr = if notice.pr then "  PR #" .. tostring(notice.pr) else ""
							cx:toast("info", "Agents Hub: " .. tostring(notice.agent) .. " " .. tostring(notice.status) .. pr, nil)
						end
						seen[notice.id] = true
					end
				end
				notifications_ready = true
			end
			tern.chrome.refresh()
		end
		watch()
	end)
end
watch()
