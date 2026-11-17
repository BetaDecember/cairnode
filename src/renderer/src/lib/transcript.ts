/**
 * UI-level transcript model. The agent's `AgentEvent` stream folds into this
 * shape; the renderer never reads raw provider payloads.
 */

export type ToolStatus = 'running' | 'ok' | 'error'

export type Block =
  | { type: 'text'; text: string; streaming?: boolean }
  | { type: 'thinking'; text: string; seconds: number; streaming?: boolean }
  | {
      type: 'tool'
      id: string
      name: string
      summary: string
      status: ToolStatus
      output?: string
      elapsedMs?: number
    }
  | {
      type: 'diff'
      id: string
      path: string
      added: number
      removed: number
      lines: string[]
    }
  | {
      type: 'permission'
      id: string
      tool: string
      command: string
      risk: 'low' | 'medium' | 'high'
    }
  | { type: 'error'; id: string; title: string; detail: string; retryable: boolean }
  | { type: 'todos'; id: string; items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }> }

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; blocks: Block[] }
  | { kind: 'divider'; id: string; label: string }

export interface SessionSummary {
  id: string
  title: string
  preview: string
  group: string
  active?: boolean
}
