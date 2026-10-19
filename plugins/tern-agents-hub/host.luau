--!strict
-- The `panel` block: Agents Hub runs, pending-review count and runner
-- status, read from the operations catalog via `agent call open_dashboard`
-- (one op per poll) and `agent call get_run` for the detail view.
--
-- Keys: ↑/↓ (or k/j) move, Enter opens the run detail, q/Esc closes the
-- detail, r refreshes. Read-only: ratings, decisions and starting runs stay
-- in the Agents Hub apps where the user makes them.

local ui = tern.ui

-- The agent CLI from the operations catalog, found the way agents-panel
-- finds it: a PATH with the usual user folders in front (Dock apps get a
-- minimal PATH), then `command -v agent`. Resolved once per block.
local LAUNCH = {
	"/bin/sh",
	"-c",
	'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" exec agent call "$1" "$2"',
	"agent",
}

local OP_TIMEOUT_MS = 15 * 1000
local MAX_DETAIL_BYTES = 12 * 1024

local POLL_ACTIVE_MS = 5 * 1000 -- any run still running, or a detail open
local POLL_IDLE_MS = 30 * 1000 -- nothing moving: back off
local POLL_ERROR_MS = 60 * 1000 -- after a failed poll
local EMPTY_TICKS_TO_BACKOFF = 4 -- idle polls before slowing down

-- Where each badge of a run status points; unknown statuses fall back to info.
local STATUS_TONE: { [string]: string } = {
	completed = "success",
	running = "accent",
	blocked = "warning",
	failed = "error",
	interrupted = "warning",
	rated = "success",
}

type Run = {
	key: string,
	agent: string,
	title: string,
	status: string,
	started: number?,
	ended: number?,
	cost: number?,
	pr_number: number?,
	pr_url: string?,
	runner: string?,
}

type Detail = { kind: string, run_id: string?, text: string }

type Problem = { text: string, detail: string? }

type State = {
	cx: BlockCx,
	source: string?,
	runs: { Run }?,
	pending: number,
	running: number,
	status_line: string,
	cursor: string?,
	detail: Detail?,
	detail_run: any,
	loading: boolean,
	fetched: number?,
	problem: Problem?,
	timer: TimerHandle?,
	empty_ticks: number,
	generation: number,
}

-- A pane ID survives Restart; the state object identifies this block run.
local running: { [number]: State } = {}

local function retire(state: State)
	if running[state.cx.pane] == state then
		running[state.cx.pane] = nil
	end
	if state.timer then
		state.timer:cancel()
		state.timer = nil
	end
	state.generation += 1
	state.loading = false
	state.runs = nil
	state.cursor = nil
	state.detail = nil
	state.problem = nil
	state.fetched = nil
end

-- Seconds since the epoch of an ISO 8601 UTC time (`2026-10-19T02:08:03.524Z`),
-- by the days-from-civil algorithm: `os.time` with a table reads local time.
local function epoch(iso: string): number?
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
	local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
	local days = era * 146097 + doe - 719468
	return days * 86400 + (tonumber(hh) :: number) * 3600 + (tonumber(mm) :: number) * 60 + (tonumber(ss) :: number)
end

-- How long ago `t` was, compactly: `12m`, `5h`, `3d`.
local function age(t: number): string
	local s = math.max(0, os.time() - t)
	if s < 3600 then
		return math.max(1, s // 60) .. "m"
	elseif s < 86400 then
		return s // 3600 .. "h"
	end
	return s // 86400 .. "d"
end

-- `4m11s`, `1.3h`; ended runs only.
local function duration(started: number?, ended: number?): string?
	if not (started and ended) then
		return nil
	end
	local s = math.max(0, ended - started)
	if s < 3600 then
		return math.max(1, s // 60) .. "m" .. string.format("%02d", s % 60) .. "s"
	end
	return string.format("%.1fh", s / 3600)
end

-- Check this run first, not just its pane: Restart reuses the pane ID.
-- Blocks have no close hook, so callbacks also retire a disappeared pane.
local function alive(state: State): boolean
	if running[state.cx.pane] ~= state then
		return false
	end
	for _, p in tern.pane.list() do
		if p.pane == state.cx.pane then
			return true
		end
	end
	retire(state)
	return false
end

local function first_lines(text: string, n: number): string
	local out = {}
	for line in string.gmatch(text, "[^\n]+") do
		table.insert(out, line)
		if #out == n then
			break
		end
	end
	return table.concat(out, "\n")
end

-- Starts `agent call <op> <json>` via sh's PATH search; the spawn error
-- when it will not start.
local function call_agent(op: string, json: string, done: (ProcessResult) -> ()): string?
	local argv: { string } = { LAUNCH[1], LAUNCH[2], LAUNCH[3], LAUNCH[4], op, json }
	local opts: ProcessOptions = {
		timeout_ms = OP_TIMEOUT_MS,
		env = { NO_COLOR = "1", CI = "1" },
	}
	local ok, err = pcall(function()
		tern.process.run(argv, opts, function(result: ProcessResult, _)
			done(result)
		end)
	end)
	if ok then
		return nil
	end
	return tostring(err)
end

-- Runs newest first; the Hub order is trusted when timestamps are missing.
local function parse_runs(data: any): { Run }
	local runs: { Run } = {}
	local list = if type(data) == "table" and type(data.runs) == "table" then data.runs else {}
	for _, item in list do
		if type(item) == "table" and type(item.run_id) == "string" then
			local publication = if type(item.publication) == "table" then item.publication else nil
			local review = if type(item.review) == "table" then item.review else nil
			local pr_number = nil
			local pr_url = nil
			for _, src in { publication, review } do
				if src then
					pr_number = pr_number or tonumber(src.pr_number)
					if not pr_url and type(src.pr_url) == "string" then
						pr_url = src.pr_url
					end
				end
			end
			table.insert(runs, {
				key = item.run_id,
				agent = tostring(item.agent or "?"),
				title = tostring(item.title or ""),
				status = tostring(item.status or "?"),
				started = if type(item.started) == "string" then epoch(item.started) else nil,
				ended = if type(item.ended) == "string" then epoch(item.ended) else nil,
				cost = tonumber(item.cost_usd),
				pr_number = pr_number,
				pr_url = pr_url,
				runner = if type(item.runner) == "string" then item.runner else nil,
			})
		end
	end
	table.sort(runs, function(a, b)
		if a.started and b.started then
			return a.started > b.started
		end
		return (a.started ~= nil) == (b.started ~= nil) and a.key > b.key or a.started ~= nil
	end)
	return runs
end

-- One line about the machine that runs things, for the dock.
local function status_line(data: any): string
	local relay = if type(data) == "table" and type(data.relay) == "table" then data.relay else nil
	if relay then
		if relay.online == true then
			local agents = if type(relay.agents) == "table" then #relay.agents else 0
			return "dok online · " .. agents .. " agents"
		end
		return "dok offline · local reads only"
	end
	if type(data) == "table" and data.source == "local" then
		return "Hub unreachable · local data"
	end
	return "runner status unknown"
end

local function index_of(state: State): number
	local runs: { Run } = state.runs or {}
	for i, run in runs do
		if run.key == state.cursor then
			return i
		end
	end
	return 0
end

local function refresh(state: State)
	if not alive(state) or state.loading then
		return
	end
	state.loading = true
	local generation = state.generation
	local spawn_error = call_agent("open_dashboard", "{}", function(result)
		if not alive(state) or state.generation ~= generation then
			return
		end
		state.loading = false
		if result.status ~= 0 then
			state.problem = {
				text = if result.timed_out
					then "agent call did not answer within 15 seconds."
					else "agent call exited with status " .. result.status .. ".",
				detail = first_lines(result.stderr ~= "" and result.stderr or result.stdout, 6),
			}
		else
			local ok, data = pcall(tern.json.decode, result.stdout)
			if ok and type(data) == "table" and type(data.runs) == "table" then
				local runs = parse_runs(data)
				state.runs = runs
				state.problem = nil
				state.fetched = os.time()
				state.source = if type(data.source) == "string" then data.source else nil
				state.status_line = status_line(data)
				state.pending = 0
				if type(data.pending) == "table" then
					state.pending = #data.pending
				end
				state.running = 0
				for _, run in runs do
					if string.lower(run.status) == "running" then
						state.running += 1
					end
				end
				-- Keep the cursor on an existing row.
				local found = false
				for _, run in runs do
					found = found or run.key == state.cursor
				end
				if not found then
					state.cursor = if runs[1] then runs[1].key else nil
				end
			else
				state.problem = {
					text = "agent call printed something other than the dashboard JSON.",
					detail = first_lines(result.stdout, 4),
				}
			end
		end
		state.cx:render()
	end)
	if spawn_error then
		state.loading = false
		state.problem = {
			text = "Tern could not start the agent CLI.",
			detail = spawn_error,
		}
	end
end

local function show_detail(state: State)
	local run = (state.runs or {})[index_of(state)]
	if not run then
		return
	end
	state.detail = { kind = "loading", run_id = run.key, text = "" }
	local generation = state.generation
	local spawn_error = call_agent("get_run", tern.json.encode({ run_id = run.key }), function(result)
		if not alive(state) or state.generation ~= generation then
			return
		end
		if not (state.detail and state.detail.run_id == run.key) then
			return -- the user closed the detail or moved on
		end
		if result.status ~= 0 then
			state.detail = {
				kind = "error",
				run_id = run.key,
				text = "agent call get_run exited with status "
					.. result.status
					.. ".\n"
					.. first_lines(result.stderr ~= "" and result.stderr or result.stdout, 6),
			}
		else
			local ok, data = pcall(tern.json.decode, result.stdout)
			if ok and type(data) == "table" and data.run_id then
				if type(data.output) == "string" and string.len(data.output) > MAX_DETAIL_BYTES then
					data.output = string.sub(data.output, 1, MAX_DETAIL_BYTES) .. "\n…"
				end
				state.detail = { kind = "run", run_id = run.key, text = "" }
				state.detail_run = data
			else
				state.detail = {
					kind = "error",
					run_id = run.key,
					text = "agent call get_run printed something other than the run JSON.\n"
						.. first_lines(result.stdout, 4),
				}
			end
		end
		state.cx:render()
	end)
	if spawn_error then
		state.detail = { kind = "error", run_id = run.key, text = "Tern could not start the agent CLI.\n" .. spawn_error }
	end
end

-- One pending timer per live run, canceled explicitly when it is replaced.
local function poll(state: State)
	if not alive(state) or state.timer then
		return
	end
	local delay = POLL_IDLE_MS
	if state.problem and not state.runs then
		delay = POLL_ERROR_MS
	elseif state.running > 0 or (state.detail and state.detail.run_id ~= nil) then
		delay = POLL_ACTIVE_MS
	elseif state.empty_ticks < EMPTY_TICKS_TO_BACKOFF then
		delay = POLL_ACTIVE_MS -- fresh panel: settle quickly, then slow down
	end
	state.timer = tern.timer(delay, function()
		if not alive(state) then
			return
		end
		state.timer = nil
		state.empty_ticks += 1
		refresh(state)
		poll(state)
	end)
end

local LIST_ID = "main.runs."

-- Rows scroll inside the list (see review-queue): keep the cursor visible.
local function list_lines(cx: BlockCx): number
	return math.max(4, math.floor((cx.rows - 4) * 0.72))
end

local function list_view(state: State): Node
	local items: { Item } = {}
	for _, run in state.runs :: { Run } do
		local label: { Span | string } = {}
		table.insert(label, ui.span(string.upper(run.status) .. "  ", if STATUS_TONE[string.lower(run.status)] then string.lower(run.status) else "info"))
		table.insert(label, ui.span(run.agent .. "  ", "muted"))
		table.insert(label, ui.span(run.title))
		local value: { Span | string } = {}
		if run.pr_number then
			table.insert(value, ui.span("PR#" .. run.pr_number .. "  ", "info"))
		end
		local took = duration(run.started, run.ended)
		if took then
			table.insert(value, ui.span(took .. "  ", "muted num"))
		end
		if run.started then
			table.insert(value, ui.span(age(run.started) .. "  ", "muted num"))
		end
		if run.cost then
			table.insert(value, ui.span(string.format("$%.3f", run.cost), "muted num"))
		end
		table.insert(items, {
			label = label,
			value = value,
			icon = if string.lower(run.status) == "running" then "activity" else nil,
		})
	end
	local list = ui.list(items)
	local kids = list.c or {}
	for i, run in state.runs :: { Run } do
		local p: { [string]: any } = kids[i].p or {}
		p.key = run.key
		kids[i].p = p
	end
	local p: { [string]: any } = list.p or {}
	p.key = "runs"
	p.selected = if state.cursor then LIST_ID .. state.cursor else nil
	p.empty = { ui.span("No runs yet.", "muted") }
	p.max = { lines = list_lines(state.cx) }
	list.p = p
	return list
end

local function kv_rows(run: any): Node
	local rows: { { any } } = {}
	local function add(k: string, v: any)
		if v ~= nil and v ~= "" then
			table.insert(rows, { k, tostring(v) })
		end
	end
	add("run", run.run_id)
	add("agent", run.agent)
	add("status", run.status)
	add("runner", run.runner)
	add("model", run.model)
	add("thinking", run.thinking)
	add("started", run.started)
	add("ended", run.ended)
	if type(run.usage) == "string" then
		add("usage", run.usage)
	end
	if type(run.publication) == "table" then
		add("publication", run.publication.status)
	end
	local node = ui.kv(rows)
	if type(run.publication) == "table" and type(run.publication.pr_url) == "string" then
		local items = node.p and node.p.items
		if type(items) == "table" then
			table.insert(items, {
				k = { ui.span("PR") },
				v = { ui.link(run.publication.pr_url, run.publication.pr_url) },
			})
		end
	end
	return node
end

local function detail_view(state: State): Node
	local detail = state.detail :: Detail
	if detail.kind == "loading" then
		return ui.progress(nil, "Loading " .. (detail.run_id or "") .. "…")
	end
	if detail.kind == "error" then
		return ui.card({ ui.span("Could not load the run", "strong") }, {
			ui.code(detail.text),
			ui.text({ ui.span("q close  r retry", "dim") }),
		})
	end
	local run = state.detail_run
	local children: { Node } = { kv_rows(run) }
	if type(run.output) == "string" and run.output ~= "" then
		table.insert(children, ui.rule("output"))
		table.insert(children, ui.md(run.output))
	end
	local rows = run.progress_rows
	if type(rows) == "string" and rows ~= "" and rows ~= "[]" then
		table.insert(children, ui.rule("progress"))
		table.insert(children, ui.code(rows))
	end
	table.insert(children, ui.text({ ui.span("q close  r refresh", "dim") }))
	return ui.col(children)
end

local function dock_view(state: State): Node
	local status: { Span | string } = {}
	if state.detail then
		table.insert(status, ui.span("run detail", "strong"))
	elseif state.runs then
		table.insert(status, ui.span(#(state.runs :: { Run }) .. " runs", "strong"))
	end
	if state.running > 0 then
		table.insert(status, ui.span("  " .. state.running .. " running", "accent"))
	end
	if state.pending > 0 then
		table.insert(status, ui.span("  " .. state.pending .. " to review", "warning"))
	end
	table.insert(status, ui.span("  " .. state.status_line, "muted"))
	if state.loading then
		table.insert(status, ui.span("  refreshing…", "muted"))
	elseif state.fetched then
		table.insert(status, ui.span("  updated " .. os.date("%H:%M", state.fetched), "muted"))
	end
	local lines: { Node } = { ui.text(status) }
	local problem = state.problem
	if problem then
		table.insert(lines, ui.text({ ui.span(problem.text, "warning"), ui.span("  showing the last list", "muted") }))
	end
	if not state.detail then
		table.insert(
			lines,
			ui.text({
				ui.span("↑↓ move  ⏎ detail  r refresh", "dim"),
			})
		)
	end
	return ui.col({ ui.lines(lines) })
end

local function problem_view(problem: Problem): Node
	local children: { Node } = {
		ui.md(problem.text .. " The panel runs `agent call` from your PATH (`~/.local/bin`, …). Press **r** to try again."),
	}
	if problem.detail and problem.detail ~= "" then
		table.insert(children, ui.code(problem.detail))
	end
	local retry = ui.badge("Retry", "accent")
	local rp: { [string]: any } = retry.p or {}
	rp.actions = { click = "retry" }
	retry.p = rp
	table.insert(children, ui.row({ retry }))
	local card = ui.card({ ui.span("Agents Hub unavailable", "strong") }, children)
	local p: { [string]: any } = card.p or {}
	p.tone = "error"
	card.p = p
	return card
end

tern.block.define("panel", {
	init = function(cx: BlockCx, _args: { string }, _saved: any): State
		local previous = running[cx.pane]
		if previous then
			retire(previous)
		end
		local state: State = {
			cx = cx,
			source = nil,
			runs = nil,
			pending = 0,
			running = 0,
			status_line = "loading…",
			cursor = nil,
			detail = nil,
			detail_run = nil,
			loading = false,
			fetched = nil,
			problem = nil,
			timer = nil,
			empty_ticks = 0,
			generation = 0,
		}
		running[cx.pane] = state
		refresh(state)
		poll(state)
		return state
	end,

	title = function(state: State): string?
		if state.runs then
			return "Agents Hub (" .. #(state.runs :: { Run }) .. ")"
		end
		return "Agents Hub"
	end,

	view = function(state: State, _cx: BlockCx): BlockView
		local main: Node
		if state.detail then
			main = detail_view(state)
		elseif state.runs then
			main = list_view(state)
		elseif state.problem then
			main = problem_view(state.problem)
		else
			main = ui.progress(nil, "Loading Agents Hub…")
		end
		-- A region draws its root node's children, not the root itself, so the
		-- view sits inside a column (see review-queue).
		return { main = ui.col({ main }), dock = if state.runs then dock_view(state) else nil }
	end,

	key = function(state: State, key: Key, _cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local k = key.text or key.name
		if state.detail then
			if k == "q" or key.name == "escape" then
				state.detail = nil
				state.detail_run = nil
			elseif k == "r" then
				local run_id = state.detail.run_id
				state.detail = nil
				state.detail_run = nil
				if run_id then
					state.cursor = run_id
					show_detail(state)
				end
			else
				return false
			end
			return true
		end
		local i = index_of(state)
		if key.name == "up" or k == "k" then
			local runs = state.runs or {}
			local run = runs[math.clamp(i - 1, 1, math.max(1, #runs))]
			if run then
				state.cursor = run.key
			end
		elseif key.name == "down" or k == "j" then
			local runs = state.runs or {}
			local run = runs[math.clamp(i + 1, 1, math.max(1, #runs))]
			if run then
				state.cursor = run.key
			end
		elseif key.name == "page_up" then
			local runs = state.runs or {}
			local run = runs[math.clamp(i - 10, 1, math.max(1, #runs))]
			if run then
				state.cursor = run.key
			end
		elseif key.name == "page_down" then
			local runs = state.runs or {}
			local run = runs[math.clamp(i + 10, 1, math.max(1, #runs))]
			if run then
				state.cursor = run.key
			end
		elseif key.name == "enter" then
			show_detail(state)
		elseif k == "r" then
			state.empty_ticks = 0
			refresh(state)
		else
			return false
		end
		return true
	end,

	event = function(state: State, ev: UiEvent, _cx: BlockCx)
		if ev.ev == "action" and ev.act == "retry" then
			state.empty_ticks = 0
			refresh(state)
		elseif (ev.ev == "select" or ev.ev == "activate") and type(ev.item) == "string" then
			state.cursor = string.sub(ev.item, #LIST_ID + 1)
			if ev.ev == "activate" then
				show_detail(state)
			end
		end
	end,
})
