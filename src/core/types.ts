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

/** A stored boundary where history was replaced by a summary. */
export interface CompactionRecord {
  at: string
  summary: string
  /** The active user instruction kept verbatim after the summary. */
  task: string
  /** Conversation messages replaced by the summary. */
  dropped: number
  /** Index in the stored transcript where the boundary sits. */
  index: number
}

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
  /** 0..1 of the effective context window, which is `numCtx`, not the model's max. */
  contextPct: number
  /** The context window the run is actually using. */
  contextWindow: number
  /** True when the numbers came from an estimator rather than the provider. */
  estimated: boolean
  /** Prompt tokens served from the KV cache. Zero on a cold prefix. */
  cachedTokens: number
}

/** The single event stream that drives the UI. */
export type AgentEvent =
  | { type: 'session_state'; state: SessionState }
  | { type: 'thinking_delta'; text: string; source: 'native' | 'narrated' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; summary: string }
  | { type: 'tool_progress'; id: string; chunk: string }
  | { type: 'tool_result'; id: string; ok: boolean; content: ContentBlock[] }
  | {
      type: 'tool_diff'
      id: string
      path: string
      added: number
      removed: number
      lines: string[]
    }
  | {
      type: 'permission_request'
      id: string
      tool: string
      summary: string
      risk: RiskLevel
    }
  | { type: 'todo_update'; items: TodoItem[] }
  | {
      /** A retryable provider failure is being waited out before another try. */
      type: 'retry'
      errorClass: ErrorClass
      attempt: number
      maxAttempts: number
      /** Time left in the current backoff, so the UI can count down. */
      waitMs: number
    }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'compaction'
      summary: string
      /** The user instruction kept verbatim after the summary. */
      task: string
      /** Conversation messages replaced by the summary. */
      dropped: number
    }
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
  /** First line of the last assistant reply, for the sidebar. */
  preview: string
  messageCount: number
}
