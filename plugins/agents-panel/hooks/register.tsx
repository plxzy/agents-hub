/**
 * Agents panel: your Pi agents beside the conversation. Everything comes from the operations catalog
 * (`agent-workflow/ops.mjs`) through `agent call <op>`; this mod only draws. Accept, Reject and Start are your
 * clicks; the model never sees or presses them.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { AgentInfo, Detail, Form, Pending, Run, Snapshot, Tab } from '../types'

// Absolute paths, like the agents plugin's .mcp.json: installed plugins are copied into a cache.
const NODE = '/Users/you/.local/bin/node'
const AGENT = '/Users/you/Development/dev-workflow/agent-workflow/agent.mjs'
const PANE = 'agents'
const RECENT = 50
const FAST_MS = 4000 // while something runs
const SLOW_MS = 30000

const snapshot = atom({ plugin: 'agents-panel', key: 'snapshot' } as const, null)
const detail = atom({ plugin: 'agents-panel', key: 'detail' } as const, null)
const error = atom({ plugin: 'agents-panel', key: 'error' } as const, null)
const tab = atom({ plugin: 'agents-panel', key: 'tab' } as const, 'runs')
const rejecting = atom({ plugin: 'agents-panel', key: 'rejecting' } as const, null)
const form = atom({ plugin: 'agents-panel', key: 'form' } as const, null)
const starting = atom({ plugin: 'agents-panel', key: 'starting' } as const, false)

// The module's own: the session's folder (for agents that work "here") and the one refresh timer.
let sessionCwd = ''
let timer: { cancel(): void } | undefined

async function call($: Engine, op: string, args: Record<string, unknown> = {}) {
  const { exitCode, stdout, stderr } = await $.process.run([NODE, AGENT, 'call', op, JSON.stringify(args)], { timeoutMs: 40000 })
  if (exitCode !== 0) throw new Error((stderr || stdout).trim().split('\n').pop() || `agent call ${op} failed`)
  return JSON.parse(stdout)
}

const firstLine = (t: unknown, n = 60) => {
  const s = String(t ?? '').trim().split('\n')[0] ?? ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
const ago = (iso: string | undefined, now: number) => (iso ? span(now - Date.parse(iso)) : '')

const GLYPH: Record<string, string> = { running: '●', completed: '✓', failed: '✕', interrupted: '✕' }
const statusColor = (status: string) =>
  status === 'completed' ? 'success' : status === 'running' ? 'warning' : status === 'failed' || status === 'interrupted' ? 'error' : 'subtle'

const fail = ($: Engine) => (err: unknown) => update($, error, () => String((err as Error)?.message ?? err))

async function refresh($: Engine): Promise<Snapshot | null> {
  try {
    const d = await call($, 'open_dashboard')
    const runs: Run[] = (d.runs ?? []).map((r: Run) => ({
      run_id: r.run_id, agent: r.agent, status: r.status, runner: r.runner, task: firstLine(r.task ?? (r as Run & { title?: string }).title, 200), started: r.started, ended: r.ended, tool_calls: r.tool_calls, progress_summary: r.progress_summary,
    }))
    const snap: Snapshot = {
      at: d.generated_at,
      runnerSelection: d.runner_selection === 1,
      targets: (d.run_targets ?? []).map((t: any) => ({ ...t, agents: (t.agents ?? []).map((a: any) => ({ ...a, here: a.workspace === 'here' })) })),
      startRequests: d.start_requests ?? [],
      source: d.source ?? 'local',
      decisionMessage: d.decision_message ?? '',
      counts: { running: d.status?.running ?? runs.filter(r => r.status === 'running').length,
        review: d.status?.pending ? d.status.pending.memory + d.status.pending.proposals : (d.pending ?? []).length },
      agents: (d.agents ?? []).map((a: { name: string; description?: string; workspace?: string; last_run?: AgentInfo['lastRun'] }) => ({
        name: a.name, description: firstLine(a.description, 120), here: a.workspace === 'here', lastRun: a.last_run,
      })),
      running: runs.filter(r => r.status === 'running'),
      recent: runs.filter(r => r.status !== 'running').slice(-RECENT).reverse(),
      pending: (d.pending ?? []).map((p: Pending) => ({ id: p.id, kind: p.kind, agent: p.agent, why: p.why, body: String(p.body ?? '').slice(0, 2000), hub: p.hub === true || d.source === 'hub' })),
    }
    await update($, snapshot, () => snap)
    await update($, error, () => null)
    const { running, review } = snap.counts
    $.ui.status(running || review
      ? `agents: ${[running && `${running} running`, review && `${review} to review`].filter(Boolean).join(' · ')}`
      : undefined)
    return snap
  } catch (err) {
    await fail($)(err)
    return null
  }
}

// One timer chain: fast while a run is going (and the open run's output follows it), slow otherwise.
async function tick($: Engine) {
  timer?.cancel()
  const snap = await refresh($)
  const shown = await read($, detail)
  if (shown && ['running', 'unknown'].includes(shown.status)) await openRun($, shown.run_id)
  timer = $.clock.after(snap?.running.length ? FAST_MS : SLOW_MS, () => void tick($))
}

async function openRun($: Engine, runId: string) {
  try {
    const r = await call($, 'get_run', { run_id: runId })
    const text = String(r.output || (r.status === 'running' ? '_Still running…_' : '_No output._'))
    const took = r.ended && r.started ? span(Date.parse(r.ended) - Date.parse(r.started)) : ''
    const tokens = r.usage?.total_tokens ?? r.usage?.totalTokens
    const meta = [r.runner ?? 'mac', String(r.model ?? '').split('/').pop(), took, r.tool_calls != null && `${r.tool_calls} tool calls`, tokens && `${tokens} tokens`]
      .filter(Boolean).join(' · ')
    await update($, detail, () => ({ run_id: r.run_id, agent: r.agent, status: r.status, runner: r.runner, task: String(r.task ?? r.title ?? ''), text: text.slice(0, 20000), meta,
      trace: r.trace ?? [['Run context', 'Unavailable — update local operations to view recorded context']],
      error: r.error, partial: r.output_partial === true, failureRows: r.failure_rows ?? [], progressRows: r.progress_rows ?? [], configurationRows: r.configuration_rows ?? [] }))
  } catch (err) {
    await fail($)(err)
  }
}

async function decide($: Engine, id: string, decision: 'accept' | 'reject', reason?: string) {
  try {
    const snap = await read($, snapshot)
    if (snap?.pending.find(p => p.id === id)?.hub) throw new Error(snap.decisionMessage)
    await call($, 'review_decide', reason ? { id, decision, reason } : { id, decision })
    await update($, rejecting, () => null)
    await refresh($)
  } catch (err) {
    await fail($)(err)
  }
}

async function start($: Engine, f: Form, task: string) {
  if (!task.trim() || await read($, starting)) return
  try {
    const snap = await read($, snapshot)
    if (!snap?.runnerSelection) throw new Error('Update the local operations before selecting a runner.')
    const target = snap.targets.find(t => t.id === f.runner), agent = target?.agents.find(a => a.name === f.agent)
    if (!target?.available || !agent || agent.reason) throw new Error(target?.reason ?? agent?.reason ?? 'Select an available agent.')
    await update($, starting, () => true)
    const args: Record<string, unknown> = { runner: f.runner, agent: f.agent, task: task.trim(), request_id: crypto.randomUUID() }
    if (f.runner === 'mac' && f.cwd) args.cwd = f.cwd
    const result = await call($, 'start_selected_run', args)
    await tick($)
    if (!result.run_id) throw new Error(result.message ?? 'Start unresolved. Check the saved request below.')
    await update($, form, () => null)
    await update($, tab, () => 'runs' as Tab)
    await openRun($, result.run_id)
  } catch (err) { await fail($)(err) }
  finally { await update($, starting, () => false) }
}

async function checkStart($: Engine, requestId: string) {
  try {
    const result = await call($, 'get_selected_start', { request_id: requestId })
    await tick($)
    if (result.run_id) await openRun($, result.run_id)
    else throw new Error(result.message ?? 'Start still unresolved; no new task was submitted.')
  } catch (err) { await fail($)(err) }
}

async function openStart($: Engine) {
  await refresh($)
  await update($, form, () => ({ runner: 'dok', agent: '', cwd: '' }))
  await update($, tab, () => 'start' as Tab)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionCwd = e.cwd
    await $.command.register({ name: 'agents-panel', description: 'Open the Agents panel: runs, output, review, start a run' })
    void $.ui.open({ id: PANE, title: 'Agents' })
    void tick($)
    return started
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents', focus: true })
    await refresh($)
    return { text: 'Agents panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    // Fields exist on every surface but mobile: there Reject skips the reason and the Start tab is hidden.
    const Input = 'Input' in els ? els.Input : undefined
    const Select = 'Select' in els ? els.Select : undefined
    const snap = await read($, snapshot)
    const shown = await read($, detail)
    const err = await read($, error)
    const current = await read($, tab)
    const rejectId = await read($, rejecting)
    const f = await read($, form)
    const isStarting = await read($, starting)
    const now = snap ? Date.parse(snap.at) : 0
    const width = Math.max(30, (e.props.bodyColumns ?? 50) - 6)

    const chip = (key: string, label: string, color: string) => (
      <Box key={key} borderStyle="round" borderDimColor paddingX={1}>
        <Text color={color}>{label}</Text>
      </Box>
    )

    const header = (
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        {snap && chip('c-agents', `${snap.agents.length} agents`, 'text')}
        {snap && chip('c-running', `${snap.counts.running} running`, snap.counts.running ? 'warning' : 'subtle')}
        {snap && chip('c-review', `${snap.counts.review} to review`, snap.counts.review ? 'warning' : 'subtle')}
        <Button key="refresh" plain dimColor hotkey="r" onPress={() => void tick($)}>Refresh</Button>
      </Box>
    )

    const tabs = (
      <Box flexDirection="row" gap={1}>
        {([['runs', 'Runs', '1'], ['review', `Review${snap?.pending.length ? ` (${snap.pending.length})` : ''}`, '2'], ['start', 'Start a run', '3'], ['agents', 'Agents', '4']] as const)
          .filter(([id]) => id !== 'start' || (Input && Select)).map(([id, label, key]) => (
          <Button key={`tab-${id}`} hotkey={key} variant={current === id ? 'primary' : undefined} dimColor={current !== id}
            onPress={() => void (id === 'start' ? openStart($) : update($, tab, () => id as Tab))}>{label}</Button>
        ))}
      </Box>
    )

    const errorLine = err && (
      <Box borderStyle="round" borderColor="error" paddingX={1}>
        <Text color="error" wrap="wrap">{err}</Text>
      </Box>
    )

    // ---- one run, full output ----
    if (shown) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="back" hotkey="b" onPress={() => void update($, detail, () => null)}>← Back</Button>
            <Text color={statusColor(shown.status)}>{`${GLYPH[shown.status] ?? '·'} ${shown.status}`}</Text>
            <Text bold>{shown.agent}</Text>
          </Box>
          {errorLine}
          <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
            <Text dimColor>Task</Text>
            <Text wrap="wrap">{shown.task}</Text>
          </Box>
          {shown.meta && <Text dimColor>{shown.meta}</Text>}
          {(shown.progressRows ?? []).map(([label, value]) => <Text key={`progress-${label}`} wrap="wrap">{`${label}: ${value}`}</Text>)}
          {shown.error && <Text color="error" wrap="wrap">{`Error: ${shown.error}`}</Text>}
          {(shown.failureRows ?? []).map(([label, value]) => <Text key={`failure-${label}`} wrap="wrap">{`${label}: ${value}`}</Text>)}
          <Text bold>Configuration observed for this run</Text>
          {(shown.configurationRows ?? [['Configuration', 'Unavailable — reopen this run to load recorded configuration']]).map(([label, value]) => <Text key={`configuration-${label}`} wrap="wrap">{`${label}: ${value}`}</Text>)}
          {shown.partial && <Text bold>Partial output</Text>}
          <Markdown key="output" text={shown.text} />
          <Box flexDirection="column">
            <Text bold>Recorded run context</Text>
            {(shown.trace ?? [['Run context', 'Unavailable — reopen this run to load recorded context']]).map(([label, value]) => <Text key={`trace-${label}`} wrap="wrap">{`${label}: ${value}`}</Text>)}
          </Box>
          <Text dimColor>{shown.run_id}</Text>
        </Box>
      )
    }

    const runRow = (r: Run) => (
      <Box key={`row-${r.run_id}`} flexDirection="column" paddingX={1} hover={{ backgroundColor: 'subtle' }}>
        <Box flexDirection="row" gap={1} justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Text color={statusColor(r.status)}>{`${GLYPH[r.status] ?? '·'} ${r.runner ?? 'mac'}`}</Text>
            <Button key={`run-${r.run_id}`} plain onPress={() => void openRun($, r.run_id)}>{r.agent}</Button>
          </Box>
          <Text dimColor>{r.status === 'running' ? `running ${ago(r.started, now)}` : `${ago(r.ended ?? r.started, now)} ago`}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{firstLine(r.task, width)}</Text>
        {r.progress_summary && <Text wrap="wrap">{r.progress_summary}</Text>}
      </Box>
    )

    const runsView = snap && (
      <Box flexDirection="column" gap={1}>
        {snap.running.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingY={0}>
            <Box paddingX={1}><Text bold color="warning">Running</Text></Box>
            {snap.running.map(runRow)}
          </Box>
        )}
        <Box flexDirection="column" borderStyle="round" borderDimColor>
          <Box paddingX={1}><Text bold>Recent runs</Text></Box>
          {snap.recent.length === 0 && <Box paddingX={1}><Text dimColor>No runs yet.</Text></Box>}
          {snap.recent.map(runRow)}
        </Box>
      </Box>
    )

    const reviewCard = (p: Pending) => (
      <Box key={`card-${p.id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
        <Text color="suggestion">{`${p.kind}${p.agent ? ` · from ${p.agent}` : ''}${p.why ? ` · ${p.why}` : ''}`}</Text>
        <Markdown key={`body-${p.id}`} text={p.body} />
        {p.hub ? <Text dimColor wrap="wrap">{snap?.decisionMessage}</Text> : rejectId === p.id && Input ? (
          <Box flexDirection="column" gap={1}>
            <Input key={`reason-${p.id}`} label="Why reject? (optional)" placeholder="Reason" submitLabel="Reject" autoFocus
              onSubmit={(value: string) => void decide($, p.id, 'reject', value.trim() || undefined)} />
            <Button key={`cancel-${p.id}`} plain dimColor onPress={() => void update($, rejecting, () => null)}>Cancel</Button>
          </Box>
        ) : (
          <Box flexDirection="row" gap={1}>
            <Button key={`accept-${p.id}`} variant="primary" onPress={() => void decide($, p.id, 'accept')}>Accept</Button>
            <Button key={`reject-${p.id}`} onPress={() => void (Input ? update($, rejecting, () => p.id) : decide($, p.id, 'reject'))}>{Input ? 'Reject…' : 'Reject'}</Button>
          </Box>
        )}
      </Box>
    )

    const reviewView = snap && (
      <Box flexDirection="column" gap={1}>
        {snap.pending.length === 0 && <Text dimColor>Nothing waits for your review.</Text>}
        {snap.pending.map(reviewCard)}
      </Box>
    )

    const agentsView = snap && (
      <Box flexDirection="column" gap={1}>
        {snap.agents.map(a => (
          <Box key={`agent-${a.name}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>{a.name}</Text>
            <Text dimColor wrap="wrap">{a.description}</Text>
            {a.lastRun ? <Button key={`last-${a.name}`} plain onPress={() => void openRun($, a.lastRun!.run_id)}>
              {`Last run: ${a.lastRun.status}${a.lastRun.ended || a.lastRun.started ? ` · ${ago(a.lastRun.ended ?? a.lastRun.started, now)} ago` : ''}`}
            </Button> : <Text dimColor>No recorded run.</Text>}
          </Box>
        ))}
      </Box>
    )

    const runner = f?.runner ?? 'dok'
    const target = snap?.targets.find(t => t.id === runner)
    const choices = target?.agents ?? []
    const chosen = choices.find(a => a.name === f?.agent) ?? choices[0]
    const startView = snap && Input && Select && (
      <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text bold>{runner === 'mac' ? 'Runs on this Mac' : 'Runs on dok'}</Text>
        {!snap.runnerSelection && <Text color="error">Update the local operations before selecting a runner.</Text>}
        <Select key="runner" label="Runner" value={runner}
          options={[{ key: 'dok', value: 'dok', label: 'dok' }, { key: 'mac', value: 'mac', label: 'This Mac' }]}
          onSelect={(value: string) => { if (!isStarting) void update($, form, () => ({ runner: value as 'mac' | 'dok', agent: '', cwd: '' })) }} />
        {target?.reason && <Text color="warning" wrap="wrap">{target.reason}</Text>}
        {chosen && <Select key="agent" label="Agent" value={chosen.name}
          options={choices.map(a => ({ key: `opt-${a.name}`, value: a.name, label: a.name }))}
          onSelect={(value: string) => { if (!isStarting) void update($, form, () => ({ runner, agent: value, cwd: '' })) }} />}
        {chosen && <Text dimColor wrap="wrap">{chosen.description}</Text>}
        {chosen?.reason && <Text color="warning" wrap="wrap">{chosen.reason}</Text>}
        <Text dimColor wrap="wrap">{runner === 'mac'
          ? `Local directory: ${chosen?.here ? sessionCwd : chosen?.workspace ?? 'not selected'}`
          : `Remote checkout: ${chosen?.repo ?? 'not available'}. Tasks that change files return review branches; this Mac's working tree is untouched.`}</Text>
        {chosen?.model && <Text dimColor>{`Model: ${chosen.model}`}</Text>}
        <Input key="task" label="Task" placeholder="What should it do?" submitLabel={isStarting ? 'Starting…' : 'Start'}
          onSubmit={(value: string) => void start($, { runner, agent: chosen?.name ?? '', cwd: runner === 'mac' && chosen?.here ? sessionCwd : '' }, value)} />
        {isStarting && <Text dimColor>Waiting for the original start response…</Text>}
        {snap.startRequests.map(r => (
          <Box key={`request-${r.request_id}`} flexDirection="column">
            <Text wrap="wrap">{`${r.runner} · ${r.state} · ${firstLine(r.task, 80)}`}</Text>
            <Text dimColor>{r.request_id}</Text>
            {r.run_id ? <Button key={`request-run-${r.request_id}`} onPress={() => void openRun($, r.run_id!)}>Open run</Button>
              : r.state === 'unknown' ? <Button key={`check-${r.request_id}`} onPress={() => void checkStart($, r.request_id)}>Check original request</Button> : <Text dimColor>{r.message}</Text>}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {snap && <Text dimColor>{snap.source === 'hub' ? 'Source: Agents Hub' : `Source: ${snap.source}`}</Text>}
        {tabs}
        {errorLine}
        {!snap && !err && <Text dimColor>Loading…</Text>}
        {current === 'runs' && runsView}
        {current === 'review' && reviewView}
        {current === 'agents' && agentsView}
        {current === 'start' && startView}
      </Box>
    )
  })
}
