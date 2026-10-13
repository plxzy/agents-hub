export type Run = { run_id: string; agent: string; status: string; runner?: string; task: string; started: string; ended?: string; tool_calls?: number }
export type Pending = { id: string; kind: string; agent?: string; why?: string; body: string; hub?: boolean }
export type AgentInfo = { name: string; description: string; here: boolean; workspace?: string; model?: string; repo?: string; reason?: string; lastRun?: { run_id: string; status: string; started?: string; ended?: string } | null }
export type StartRequest = { request_id: string; runner: string; agent: string; task: string; state: string; run_id?: string; message?: string }
export type RunTarget = { id: 'mac' | 'dok'; label: string; available: boolean; reason?: string; agents: AgentInfo[] }
export type Snapshot = {
  runnerSelection: boolean
  targets: RunTarget[]
  startRequests: StartRequest[]
  at: string
  agents: AgentInfo[]
  running: Run[]
  recent: Run[]
  pending: Pending[]
  source: string
  decisionMessage: string
  counts: { running: number; review: number }
}
export type Detail = { run_id: string; agent: string; status: string; runner?: string; task: string; text: string; meta: string; trace: [string, string][]; error?: string; partial?: boolean; failureRows?: [string, string][] }
export type Tab = 'runs' | 'review' | 'start' | 'agents'
export type Form = { runner: 'mac' | 'dok'; agent: string; cwd: string }

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': {
      snapshot: Snapshot | null
      detail: Detail | null
      error: string | null
      tab: Tab
      rejecting: string | null
      form: Form | null
      starting: boolean
    }
  }
}
