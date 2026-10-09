/**
 * Agents panel: your Pi agents beside the conversation. Everything comes from the operations catalog
 * (`agent-workflow/ops.mjs`) through `agent call <op>`; this mod only draws. Accept/Reject are your clicks;
 * the model never sees or presses them.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Detail, Pending, Run, Snapshot } from '../types'

// Absolute paths, like the agents plugin's .mcp.json: installed plugins are copied into a cache.
const NODE = '/Users/you/.local/bin/node'
const AGENT = '/Users/you/Development/dev-workflow/agent-workflow/agent.mjs'
const PANE = 'agents'
const RECENT = 8
const FAST_MS = 4000 // while something runs
const SLOW_MS = 30000

const snapshot = atom({ plugin: 'agents-panel', key: 'snapshot' } as const, null)
const detail = atom({ plugin: 'agents-panel', key: 'detail' } as const, null)
const error = atom({ plugin: 'agents-panel', key: 'error' } as const, null)

async function call($: Engine, op: string, args: Record<string, unknown> = {}) {
  const { exitCode, stdout, stderr } = await $.process.run([NODE, AGENT, 'call', op, JSON.stringify(args)], { timeoutMs: 20000 })
  if (exitCode !== 0) throw new Error((stderr || stdout).trim().split('\n').pop() || `agent call ${op} failed`)
  return JSON.parse(stdout)
}

const firstLine = (t: unknown, n = 60) => {
  const s = String(t ?? '').trim().split('\n')[0] ?? ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function ago(iso: string | undefined, now: number) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

const statusColor = (status: string) =>
  status === 'completed' ? 'success' : status === 'running' ? 'warning' : status === 'failed' || status === 'interrupted' ? 'error' : 'subtle'

async function refresh($: Engine): Promise<Snapshot | null> {
  try {
    const d = await call($, 'open_dashboard')
    const runs: Run[] = (d.runs ?? []).map((r: Run) => ({
      run_id: r.run_id, agent: r.agent, status: r.status, task: firstLine(r.task, 200), started: r.started, ended: r.ended, tool_calls: r.tool_calls,
    }))
    const snap: Snapshot = {
      at: d.generated_at,
      agents: d.status?.agents ?? 0,
      running: runs.filter(r => r.status === 'running'),
      recent: runs.filter(r => r.status !== 'running').slice(-RECENT).reverse(),
      pending: (d.pending ?? []).map((p: Pending) => ({ id: p.id, kind: p.kind, agent: p.agent, why: p.why, body: firstLine(p.body, 400) })),
    }
    await update($, snapshot, () => snap)
    await update($, error, () => null)
    const review = snap.pending.length
    $.ui.status(snap.running.length || review
      ? `agents: ${[snap.running.length && `${snap.running.length} running`, review && `${review} to review`].filter(Boolean).join(' · ')}`
      : undefined)
    return snap
  } catch (err) {
    await update($, error, () => String((err as Error)?.message ?? err))
    return null
  }
}

async function openRun($: Engine, runId: string) {
  try {
    const r = await call($, 'get_run', { run_id: runId })
    const text = String(r.output ?? r.error ?? (r.status === 'running' ? '(still running)' : '(no output)'))
    await update($, detail, () => ({ run_id: r.run_id, agent: r.agent, status: r.status, task: String(r.task ?? ''), text: text.slice(0, 4000) }))
  } catch (err) {
    await update($, error, () => String((err as Error)?.message ?? err))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'agents-panel', description: 'Open the Agents panel: runs, output and what waits for your review' })
    void $.ui.open({ id: PANE, title: 'Agents' })
    // One timer chain for the module's life: fast while a run is going, slow otherwise.
    const tick = async () => {
      const snap = await refresh($)
      if (snap?.running.length) {
        const shown = await read($, detail)
        if (shown?.status === 'running') await openRun($, shown.run_id)
      }
      $.clock.after(snap?.running.length ? FAST_MS : SLOW_MS, () => void tick())
    }
    void tick()
    return started
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents', focus: true })
    await refresh($)
    return { text: 'Agents panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const shown = await read($, detail)
    const err = await read($, error)
    const now = snap ? Date.parse(snap.at) : 0
    const width = Math.max(30, (e.props.bodyColumns ?? 50) - 2)

    const header = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold>{snap ? `${snap.agents} agents` : 'Agents'}</Text>
        {snap && <Text color={snap.running.length ? 'warning' : 'subtle'}>{`${snap.running.length} running`}</Text>}
        {snap && <Text color={snap.pending.length ? 'warning' : 'subtle'}>{`${snap.pending.length} to review`}</Text>}
        <Button key="refresh" plain dimColor hotkey="r" onPress={() => void refresh($)}>Refresh</Button>
      </Box>
    )

    if (shown) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={() => void update($, detail, () => null)}>Back</Button>
            <Text bold>{shown.agent}</Text>
            <Text color={statusColor(shown.status)}>{shown.status}</Text>
          </Box>
          <Text dimColor wrap="wrap">{shown.task}</Text>
          <Text wrap="wrap">{shown.text}</Text>
          <Text dimColor>{shown.run_id}</Text>
        </Box>
      )
    }

    const runRow = (r: Run) => (
      <Box key={r.run_id} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={statusColor(r.status)}>{r.status === 'running' ? '●' : r.status === 'completed' ? '✓' : '✕'}</Text>
          <Button key={`run-${r.run_id}`} plain onPress={() => void openRun($, r.run_id)}>{r.agent}</Button>
          <Text dimColor>{ago(r.status === 'running' ? r.started : r.ended ?? r.started, now)}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{`  ${firstLine(r.task, width)}`}</Text>
      </Box>
    )

    const reviewRow = (p: Pending) => (
      <Box key={p.id} flexDirection="column">
        <Text>{`${p.kind}${p.agent ? ` · ${p.agent}` : ''}`}</Text>
        <Text dimColor wrap="wrap">{p.body}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key={`accept-${p.id}`} onPress={() => void call($, 'review_decide', { id: p.id, decision: 'accept' }).then(() => refresh($), err => update($, error, () => String(err?.message ?? err)))}>Accept</Button>
          <Button key={`reject-${p.id}`} onPress={() => void call($, 'review_decide', { id: p.id, decision: 'reject' }).then(() => refresh($), err => update($, error, () => String(err?.message ?? err)))}>Reject</Button>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {err && <Text color="error" wrap="wrap">{err}</Text>}
        {!snap && !err && <Text dimColor>Loading…</Text>}
        {snap && snap.running.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Running</Text>
            {snap.running.map(runRow)}
          </Box>
        )}
        {snap && (
          <Box flexDirection="column">
            <Text bold>Recent runs</Text>
            {snap.recent.length === 0 && <Text dimColor>No runs yet.</Text>}
            {snap.recent.map(runRow)}
          </Box>
        )}
        {snap && snap.pending.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Waiting for your review</Text>
            {snap.pending.map(reviewRow)}
          </Box>
        )}
        {snap && <Text dimColor>{'Full dashboard: ask for "open my agents dashboard", or run `agent ui`.'}</Text>}
      </Box>
    )
  })
}
