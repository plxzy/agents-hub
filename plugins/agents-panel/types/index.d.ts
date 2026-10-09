export type Run = { run_id: string; agent: string; status: string; task: string; started: string; ended?: string; tool_calls?: number }
export type Pending = { id: string; kind: string; agent?: string; why?: string; body: string }
export type AgentInfo = { name: string; description: string; here: boolean }
export type Snapshot = {
  at: string
  agents: AgentInfo[]
  running: Run[]
  recent: Run[]
  pending: Pending[]
}
export type Detail = { run_id: string; agent: string; status: string; task: string; text: string; meta: string }
export type Tab = 'runs' | 'review' | 'start'
export type Form = { agent: string; cwd: string }

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': {
      snapshot: Snapshot | null
      detail: Detail | null
      error: string | null
      tab: Tab
      rejecting: string | null
      form: Form | null
    }
  }
}
