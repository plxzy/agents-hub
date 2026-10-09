export type Run = { run_id: string; agent: string; status: string; task: string; started: string; ended?: string; tool_calls?: number }
export type Pending = { id: string; kind: string; agent?: string; why?: string; body: string }
export type Snapshot = {
  at: string
  agents: number
  running: Run[]
  recent: Run[]
  pending: Pending[]
}
export type Detail = { run_id: string; agent: string; status: string; task: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': { snapshot: Snapshot | null; detail: Detail | null; error: string | null }
  }
}
