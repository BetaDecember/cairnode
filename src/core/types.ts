/**
 * Canonical protocol for the agent.
 *
 * These types are the contract between `src/core` (Electron-free), the main process,
 * and the renderer. They must stay free of any Electron or DOM imports so that
 * `src/core` can be tested with plain `node --test`.
 */

export type SessionState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'awaiting_permission'
  | 'compacting'

export type RiskLevel = 'low' | 'medium' | 'high'

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'cancelled'
  | 'error'
  | 'context_full'

export type ErrorClass =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'tool_unsupported'
  | 'network'
  | 'cancelled'
  | 'unknown'

/** A single unit of model or tool output in a transcript. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; source: 'native' | 'narrated' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; content: string }
  | { type: 'image'; mimeType: string; data: string }

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface Usage {
  promptTokens: number
  outputTokens: number
  /** 0..1 of the model's context window. */
  contextPct: number
  /** True when the numbers came from an estimator rather than the provider. */
  estimated: boolean
}

/** The single event stream that drives the UI. */
export type AgentEvent =
  | { type: 'session_state'; state: SessionState }
  | { type: 'thinking_delta'; text: string; source: 'native' | 'narrated' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_progress'; id: string; chunk: string }
  | { type: 'tool_result'; id: string; ok: boolean; content: ContentBlock[] }
  | {
      type: 'permission_request'
      id: string
      tool: string
      summary: string
      risk: RiskLevel
    }
  | { type: 'todo_update'; items: TodoItem[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; errorClass: ErrorClass; retryable: boolean; detail: string }
  | { type: 'done'; stopReason: StopReason }

export interface ModelInfo {
  id: string
  label: string
  providerId: string
  contextWindow: number
  capabilities: Capabilities
}

export interface Capabilities {
  nativeTools: boolean
  thinking: boolean
  jsonSchema: boolean
  contextWindow: number
  probedAt: string
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
}
