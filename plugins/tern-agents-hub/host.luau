--!strict
-- The `panel` block: Agents Hub runs, pending-review count and runner status,
-- read from the operations catalog via `agent call open_dashboard` and
-- `agent call get_run` for a run's detail. One host-wide loop polls; every
-- open panel renders from its data and the window's status segment reads the
-- `snapshot` it writes to `tern.kv`.
--
-- Keys: ↑/↓ (or k/j) move, Enter opens the run detail, q/Esc closes it,
-- Keys: ↑/↓ (or k/j) move runs, p pending reviews, Enter opens the selected
-- item, q/Esc closes detail, r refreshes. Review decisions require a second
-- press (or y) after `a`/`x` confirmation.

local ui = tern.ui

-- Dock apps get a minimal PATH, so put the usual user folders in front.
local SHELL = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" exec agent call "$1" "$2"'

local POLL_MS = 5 * 1000 -- while a run is running
local QUIET_POLL_MS = 20 * 1000 -- quiet: keep the status reasonably fresh
local OUTPUT_LINES = 40 -- head of a run's output in the detail
local RECENT_S = 10 * 60 -- the snapshot lists runs running or finished this recently

local TONES: { [string]: string } = {
	completed = "success",
	running = "accent",
	blocked = "warning",
	interrupted = "warning",
	failed = "error",
}

type Run = {
	key: string,
	agent: string,
	title: string,
	status: string,
	started: number?,
	ended: number?,
	cost: number?,
	pr: number?,
	step: string?,
}

type Pending = {
	id: string,
	agent: string,
	kind: string,
	body: string,
}

local hub = {
	runs = nil :: { Run }?,
	pending = 0,
	running = 0,
	status_line = "loading…",
	fetched = nil :: number?,
	problem = nil :: string?,
	loading = false,
	pending_items = nil :: { Pending }?,
	review_problem = nil :: string?,
	review_result = nil :: string?,
	notifications = {},
	previous_status = {} :: { [string]: string },
	had_initial_poll = false,
}

type State = {
	cx: BlockCx,
	cursor: string?,
	detail: any, -- nil, or { run_id, run?, error? } while the detail is open
	review: boolean,
	review_cursor: string?,
	review_detail: Pending?,
	confirm: string?,
}

-- The live state per pane: Restart reuses the pane id, so the old state retires.
local blocks: { [number]: State } = {}

-- Blocks have no close hook: callbacks check that the pane still exists.
local function alive(state: State): boolean
	if blocks[state.cx.pane] ~= state then
		return false
	end
	for _, p in tern.pane.list() do
		if p.pane == state.cx.pane then
			return true
		end
	end
	blocks[state.cx.pane] = nil
	return false
end

-- Seconds since the epoch of an ISO 8601 UTC time, by days-from-civil
-- (`os.time` with a table would read local time).
local function epoch(iso: any): number?
	if type(iso) ~= "string" then
		return nil
	end
	local y, m, d, hh, mm, ss = string.match(iso, "^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
	if not (y and m and d and hh and mm and ss) then
		return nil
	end
	local year, month, day = tonumber(y) :: number, tonumber(m) :: number, tonumber(d) :: number
	if month <= 2 then
		year -= 1
	end
	local era = year // 400
	local yoe = year - era * 400
	local doy = (153 * (if month > 2 then month - 3 else month + 9) + 2) // 5 + day - 1
	local days = era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468
	return days * 86400 + (tonumber(hh) :: number) * 3600 + (tonumber(mm) :: number) * 60 + (tonumber(ss) :: number)
end

-- `12m`, `5h`, `3d` ago.
local function age(t: number): string
	local s = math.max(0, os.time() - t)
	if s < 3600 then
		return math.max(1, s // 60) .. "m ago"
	elseif s < 86400 then
		return s // 3600 .. "h ago"
	end
	return s // 86400 .. "d ago"
end

-- `4m11s`, `1.3h`.
local function duration(s: number): string
	if s < 3600 then
		return s // 60 .. "m" .. string.format("%02d", s % 60) .. "s"
	end
	return string.format("%.1fh", s / 3600)
end

local function head(text: string, n: number): string
	local lines = string.split(text, "\n")
	if #lines <= n then
		return text
	end
	return table.concat(lines, "\n", 1, n) .. "\n…"
end

-- Runs `agent call <op> <json>`; `done` gets the decoded JSON or an error line.
local function call_agent(op: string, json: string, done: (any, string?) -> ())
	local ok, err = pcall(function()
		tern.process.run({ "/bin/sh", "-c", SHELL, "agent", op, json }, { timeout_ms = 15000 }, function(r: ProcessResult)
			if r.status ~= 0 then
				local why = if r.timed_out then "timed out after 15 s" else "exited " .. r.status
				done(nil, "agent call " .. op .. " " .. why .. ": " .. head(r.stderr ~= "" and r.stderr or r.stdout, 3))
				return
			end
			local decoded, data = pcall(tern.json.decode, r.stdout)
			if decoded and data ~= nil then
				done(data)
			else
				done(nil, "agent call " .. op .. " printed no JSON: " .. head(r.stdout, 2))
			end
		end)
	end)
	if not ok then
		done(nil, "could not start the agent CLI: " .. tostring(err))
	end
end

local function parse_runs(list: any): { Run }
	local runs: { Run } = {}
	for _, item in if type(list) == "table" then list else {} do
		if type(item) == "table" and type(item.run_id) == "string" then
			local publication = if type(item.publication) == "table" then item.publication else {}
			local started, ended = epoch(item.started), epoch(item.ended)
			table.insert(runs, {
				key = item.run_id,
				agent = tostring(item.agent or "?"),
				title = tostring(item.title or ""),
				status = string.lower(tostring(item.status or "?")),
				started = started,
				ended = ended,
				cost = tonumber(item.cost_usd),
				pr = if publication.status == "published" then tonumber(publication.pr_number) else nil,
				step = nil,
			})
		end
	end
	-- Run ids start with their UTC start time (`r-20261019T020803Z-…`).
	table.sort(runs, function(a, b)
		return a.key > b.key
	end)
	return runs
end

local function status_line(data: any): string
	local name = if data.source == "hub" then "Hub" else "Hub unreachable (local data)"
	local relay = data.relay
	if type(relay) ~= "table" then
		return name
	end
	local runner = tostring(relay.runner or "runner")
	if relay.online ~= true then
		return name .. " · " .. runner .. " offline"
	end
	local agents = if type(relay.agents) == "table" then #relay.agents else 0
	return name .. " · " .. runner .. " online · " .. agents .. " agents"
end

local function index_of(state: State): number
	for i, run in hub.runs or {} :: { Run } do
		if run.key == state.cursor then
			return i
		end
	end
	return 0
end

local function progress_step(progress: any): string?
	if type(progress) ~= "table" then
		return nil
	end
	local text = progress.action or progress.phase
	if type(text) ~= "string" or text == "" then
		return nil
	end
	text = string.gsub(text, "_", " ")
	return string.sub(text, 1, 40)
end

-- Enrich running rows serially; the CLI and runner are deliberately not flooded.
local function enrich_running(runs: { Run }, i: number, done: () -> ())
	while i <= #runs and runs[i].status ~= "running" do
		i += 1
	end
	if i > #runs then
		done()
		return
	end
	local run = runs[i]
	call_agent("get_run", tern.json.encode({ run_id = run.key }), function(data, _err)
		if data then
			run.step = progress_step(data.progress)
		end
		enrich_running(runs, i + 1, done)
	end)
end

-- A transient "unknown" status is not an end.
local function terminal(status: string?): boolean
	return status == "completed" or status == "failed" or status == "interrupted" or status == "cancelled"
end
local timer: TimerHandle? = nil
local poll: () -> ()

local function publish(data: any, err: string?, relay: any, runs: { Run })
	hub.problem = err
	if data then
		hub.runs = runs
		hub.fetched = os.time()
		hub.status_line = status_line(data)
		hub.pending = if type(data.pending) == "table" then #data.pending else 0
		hub.running = 0
		for _, run in runs do
			if run.status == "running" then
				hub.running += 1
			end
			local old = hub.previous_status[run.key]
			if hub.had_initial_poll and terminal(run.status) and not terminal(old) then
				table.insert(hub.notifications, { id = run.key, agent = run.agent, status = run.status, pr = run.pr })
				-- The window toasts each id once; it only needs recent events.
				if #hub.notifications > 20 then
					table.remove(hub.notifications, 1)
				end
			end
			hub.previous_status[run.key] = run.status
		end
		hub.had_initial_poll = true
	end
	local recent = tern.json.array()
	for _, run in hub.runs or {} :: { Run } do
		if #recent < 5 and (run.status == "running" or (run.ended and os.time() - run.ended < RECENT_S)) then
			table.insert(recent, {
				id = run.key, agent = run.agent, status = run.status, started = run.started,
				ended = run.ended, pr = run.pr, step = run.step,
			})
		end
	end
	local notices = tern.json.array()
	for _, notice in hub.notifications do
		table.insert(notices, notice)
	end
	pcall(tern.kv.set, "snapshot", {
		running = hub.running,
		review = hub.pending,
		runner = relay.runner,
		online = relay.online == true,
		updated = os.time(),
		problem = err ~= nil,
		runs = recent,
		notifications = notices,
	})
	for _, state in blocks do
		if alive(state) then
			if index_of(state) == 0 then
				state.cursor = if hub.runs and hub.runs[1] then hub.runs[1].key else nil
			end
			state.cx:render()
		end
	end
	if timer then
		timer:cancel()
	end
	-- Stay fast while a run is running and for a minute after one ended (publication and PR numbers land then).
	local active = hub.running > 0
	for _, run in hub.runs or {} :: { Run } do
		if run.ended and os.time() - run.ended < 60 then
			active = true
		end
	end
	timer = tern.timer(if active then POLL_MS else QUIET_POLL_MS, poll)
end

-- Fetches the catalog, then one detail record for each running row.
local function refresh()
	if hub.loading then
		return
	end
	hub.loading = true
	call_agent("open_dashboard", "{}", function(data, err)
		hub.loading = false
		local relay = if data and type(data.relay) == "table" then data.relay else {}
		if not data then
			publish(nil, err, relay, hub.runs or {})
			return
		end
		local runs = parse_runs(data.runs)
		enrich_running(runs, 1, function()
			publish(data, err, relay, runs)
		end)
	end)
end

poll = function()
	refresh()
end

local function restart()
	if timer then
		timer:cancel()
	end
	poll()
end


local function show_detail(state: State, run_id: string)
	local detail = { run_id = run_id }
	state.detail = detail
	call_agent("get_run", tern.json.encode({ run_id = run_id }), function(data, err)
		if alive(state) and state.detail == detail then
			detail.run = data
			detail.error = err
			state.cx:render()
		end
	end)
end
local function parse_pending(data: any): { Pending }
	local items: { Pending } = {}
	for _, item in if type(data) == "table" then data else {} do
		if type(item) == "table" and type(item.id) == "string" then
			table.insert(items, {
				id = item.id,
				agent = tostring(item.agent or "?"),
				kind = tostring(item.kind or "review"),
				body = tostring(item.body or item.why or ""),
			})
		end
	end
	return items
end

local function load_pending(state: State, result: string?, result_error: string?)
	state.review = true
	state.review_detail = nil
	state.confirm = nil
	hub.review_problem = result_error
	hub.review_result = result
	call_agent("list_pending", "{}", function(data, err)
		if alive(state) and state.review then
			hub.pending_items = if data then parse_pending(data) else nil
			hub.review_problem = err or hub.review_problem
			if hub.pending_items and #hub.pending_items > 0 then
				state.review_cursor = hub.pending_items[1].id
			else
				state.review_cursor = nil
			end
			state.cx:render()
		end
	end)
end

local function pending_index(state: State): number
	for i, item in hub.pending_items or {} :: { Pending } do
		if item.id == state.review_cursor then
			return i
		end
	end
	return 0
end

local function decide(state: State, decision: string)
	local item = state.review_detail
	if not item then
		return
	end
	state.confirm = nil
	call_agent("review_decide", tern.json.encode({ id = item.id, decision = decision }), function(data, err)
		if alive(state) then
			state.review_detail = nil
			load_pending(state, if err then nil else tostring(data), err)
		end
	end)
end

local REVIEW_ID = "main.review."

local function pending_view(state: State): Node
	if state.review_detail then
		local item = state.review_detail
		local children: { Node } = {
			ui.kv({ { "id", item.id }, { "agent", item.agent }, { "kind", item.kind } }),
			ui.rule("body"),
			ui.md(item.body ~= "" and item.body or "(empty)"),
		}
		if state.confirm then
			table.insert(children, ui.text({ ui.span("press " .. state.confirm .. " again or y to confirm", "warning") }))
		else
			table.insert(children, ui.text({ ui.span("a accept  x reject  q back", "dim") }))
		end
		return ui.col(children)
	end
	if hub.review_problem then
		return ui.col({ ui.text({ ui.span(hub.review_problem, "error") }), ui.text({ ui.span("r retry  q close", "dim") }) })
	end
	if not hub.pending_items then
		return ui.progress(nil, "Loading reviews…")
	end
	local items: { Item } = {}
	for _, item in hub.pending_items do
		table.insert(items, {
			label = { ui.span(item.kind .. "  ", "accent"), ui.span(item.agent .. "  ", "muted"), ui.span(string.match(item.body, "^[^\n]*") or "(empty)") },
		})
	end
	local list = ui.list(items)
	for i, item in hub.pending_items do
		local node = (list.c :: { Node })[i]
		node.p = node.p or {}
		;(node.p :: any).key = item.id
	end
	local p: { [string]: any } = list.p or {}
	p.key = "review"
	p.selected = if state.review_cursor then REVIEW_ID .. state.review_cursor else nil
	p.empty = { ui.span("No pending reviews.", "muted") }
	p.max = { lines = math.max(4, math.floor((state.cx.rows - 4) * 0.72)) }
	list.p = p
	if hub.review_result then
		return ui.col({ ui.text({ ui.span(hub.review_result, "success") }), list })
	end
	return list
end

local LIST_ID = "main.runs."

local function list_view(state: State): Node
	local runs = hub.runs :: { Run }
	local items: { Item } = {}
	for _, run in runs do
		local value: { Span | string } = {}
		if run.step then
			table.insert(value, ui.span("· " .. run.step .. "  ", "muted"))
		end
		if run.pr then
			table.insert(value, ui.span("PR #" .. run.pr .. "  ", "info"))
		end
		if run.started then
			local took = if run.ended then duration(run.ended - run.started) .. " · " else ""
			table.insert(value, ui.span(took .. age(run.started) .. "  ", "muted num"))
		end
		if run.cost then
			table.insert(value, ui.span(string.format("$%.2f", run.cost), "muted num"))
		end
		table.insert(items, {
			label = {
				ui.span(string.upper(run.status) .. "  ", TONES[run.status] or "info"),
				ui.span(run.agent .. "  ", "muted"),
				ui.span(run.title),
			},
			value = value,
		})
	end
	-- Keyed rows (`main.runs.<run_id>`) keep the selection stable across polls;
	-- a `max` height keeps the selected row in view (see review-queue).
	local list = ui.list(items)
	for i, run in runs do
		local kid = (list.c :: { Node })[i]
		kid.p = kid.p or {}
		;(kid.p :: any).key = run.key
	end
	local p: { [string]: any } = list.p or {}
	p.key = "runs"
	p.selected = if state.cursor then LIST_ID .. state.cursor else nil
	p.empty = { ui.span("No runs yet.", "muted") }
	p.max = { lines = math.max(4, math.floor((state.cx.rows - 4) * 0.72)) }
	list.p = p
	return list
end

local function detail_view(detail: any): Node
	if detail.error then
		return ui.col({ ui.text({ ui.span(detail.error, "error") }), ui.text({ ui.span("q close  r retry", "dim") }) })
	end
	local run = detail.run
	if not run then
		return ui.progress(nil, "Loading " .. detail.run_id .. "…")
	end
	local rows: { { Spans } } = {}
	for _, k in { "run_id", "agent", "status", "runner", "model", "started", "ended" } do
		if run[k] ~= nil then
			table.insert(rows, { k, tostring(run[k]) })
		end
	end
	if run.status == "running" and type(run.progress) == "table" then
		local step = progress_step(run.progress)
		if step then
			table.insert(rows, { "step", step })
		end
	end
	if type(run.usage) == "table" and tonumber(run.usage.cost) then
		table.insert(rows, { "cost", string.format("$%.3f", run.usage.cost) })
	end
	local publication = run.publication
	if type(publication) == "table" and type(publication.pr_url) == "string" then
		local pr: { Spans } = { "PR", ui.link(publication.pr_url, publication.pr_url) }
		table.insert(rows, pr)
	end
	local children: { Node } = { ui.kv(rows) }
	if type(run.progress_rows) == "table" and #run.progress_rows > 0 then
		local progress: { { Spans } } = {}
		for _, row in run.progress_rows do
			if type(row) == "table" then
				table.insert(progress, { tostring(row[1]), tostring(row[2]) })
			end
		end
		table.insert(children, ui.rule("progress"))
		table.insert(children, ui.kv(progress))
	end
	if type(run.output) == "string" and run.output ~= "" then
		table.insert(children, ui.rule("output"))
		table.insert(children, ui.md(head(run.output, OUTPUT_LINES)))
	end
	table.insert(children, ui.text({ ui.span("q close  r refresh", "dim") }))
	return ui.col(children)
end

local function dock_view(state: State): Node
	local line: { Span | string } = { ui.span(hub.status_line, "muted") }
	if hub.running > 0 then
		table.insert(line, ui.span("  " .. hub.running .. " running", "accent"))
	end
	table.insert(line, ui.span("  " .. hub.pending .. " to review", if hub.pending > 0 then "warning" else "muted"))
	if hub.fetched then
		table.insert(line, ui.span("  updated " .. os.date("%H:%M", hub.fetched), "muted"))
	end
	local lines: { Node } = { ui.text(line) }
	if hub.problem then
		table.insert(lines, ui.text({ ui.span(hub.problem, "error") }))
	end
	if state.review then
		table.insert(lines, ui.text({ ui.span("review: p close  a accept  x reject", "dim") }))
	elseif not state.detail then
		table.insert(lines, ui.text({ ui.span("j/k move  ⏎ detail  p reviews  r refresh", "dim") }))
	end
	return ui.col({ ui.lines(lines) })
end

tern.block.define("panel", {
	init = function(cx: BlockCx, _args: { string }, _saved: any): State
		local first = if hub.runs and hub.runs[1] then hub.runs[1].key else nil
		local state: State = {
			cx = cx, cursor = first, detail = nil, review = false, review_cursor = nil,
			review_detail = nil, confirm = nil,
		}
		blocks[cx.pane] = state
		restart()
		return state
	end,

	view = function(state: State, _cx: BlockCx): BlockView
		local main: Node
		if state.detail then
			main = detail_view(state.detail)
		elseif state.review then
			main = pending_view(state)
		elseif hub.runs then
			main = list_view(state)
		elseif hub.problem then
			main = ui.text({ ui.span(hub.problem, "error"), ui.span("  r retry", "dim") })
		else
			main = ui.progress(nil, "Loading Agents Hub…")
		end
		-- A region draws its root's children, so wrap the view (see review-queue).
		return { main = ui.col({ main }), dock = if hub.runs then dock_view(state) else nil }
	end,

	key = function(state: State, key: Key, _cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local k = key.text or key.name
		if state.detail then
			if k == "q" or key.name == "escape" then
				state.detail = nil
			elseif k == "r" then
				show_detail(state, state.detail.run_id)
			else
				return false
			end
			return true
		end
		if state.review then
			if state.review_detail then
				if k == "q" or key.name == "escape" then
					state.review_detail = nil
					state.confirm = nil
				elseif k == "a" or k == "x" then
					local decision = if k == "a" then "accept" else "reject"
					if state.confirm == k then
						decide(state, decision)
					else
						state.confirm = k
					end
				elseif k == "y" and state.confirm then
					decide(state, if state.confirm == "a" then "accept" else "reject")
				else
					return false
				end
				return true
			end
			if k == "q" or key.name == "escape" then
				state.review = false
			elseif k == "r" then
				load_pending(state)
			else
				local items: { Pending } = hub.pending_items or {}
				local move = if key.name == "up" or k == "k" then -1 elseif key.name == "down" or k == "j" then 1 else 0
				if move ~= 0 then
					local item = items[math.clamp(pending_index(state) + move, 1, math.max(1, #items))]
					if item then
						state.review_cursor = item.id
					end
				elseif key.name == "enter" and state.review_cursor then
					for _, item in items do
						if item.id == state.review_cursor then
							state.review_detail = item
							break
						end
					end
				else
					return false
				end
			end
			return true
		end
		local runs = hub.runs or {}
		local move = if key.name == "up" or k == "k" then -1 elseif key.name == "down" or k == "j" then 1 else 0
		if move ~= 0 then
			local run = runs[math.clamp(index_of(state) + move, 1, math.max(1, #runs))]
			if run then
				state.cursor = run.key
			end
		elseif key.name == "enter" and state.cursor then
			show_detail(state, state.cursor)
		elseif k == "p" then
			load_pending(state)
		elseif k == "r" then
			restart()
		else
			return false
		end
		return true
	end,

	-- Mouse: clicking a row selects it, double-click opens its detail.
	event = function(state: State, ev: UiEvent, _cx: BlockCx)
		if (ev.ev ~= "select" and ev.ev ~= "activate") or type(ev.item) ~= "string" then
			return
		end
		if state.review and not state.review_detail and string.sub(ev.item, 1, #REVIEW_ID) == REVIEW_ID then
			state.review_cursor = string.sub(ev.item, #REVIEW_ID + 1)
			if ev.ev == "activate" then
				for _, item in hub.pending_items or {} :: { Pending } do
					if item.id == state.review_cursor then
						state.review_detail = item
						break
					end
				end
			end
			return
		end
		if not state.review and string.sub(ev.item, 1, #LIST_ID) == LIST_ID then
			state.cursor = string.sub(ev.item, #LIST_ID + 1)
			if ev.ev == "activate" then
				show_detail(state, state.cursor :: string)
			end
		end
	end,
})

poll()
