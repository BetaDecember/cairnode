export type ToolStatus = 'running' | 'ok' | 'error'

export type RiskLevel = 'low' | 'medium' | 'high'

export type Block =
  | { type: 'text'; text: string; streaming?: boolean }
  | { type: 'thinking'; text: string; seconds?: number; streaming?: boolean }
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
      risk: RiskLevel
      resolved?: 'allowed' | 'denied'
    }
  | { type: 'error'; id: string; title: string; detail: string; retryable: boolean }
  | {
      type: 'todos'
      id: string
      items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }>
    }

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; blocks: Block[] }
  | { kind: 'divider'; id: string; label: string; detail?: string }