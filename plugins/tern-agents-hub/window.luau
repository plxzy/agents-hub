--!strict
-- The window half: a palette command and a key bind that open the Agents Hub
-- panel, or focus the one already open in this window.

local KIND = "agents-hub.panel"
local ACTION = "plugin.agents-hub.open"

local function open_panel(cx: WindowCx)
	-- One panel per window is enough: each open block polls the catalog.
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
