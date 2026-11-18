/** Provider-agnostic request/response shapes emitted by an adapter. */

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCallRecord {
  id: string
  name: string
  input: unknown
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  toolName?: string
  /** The id of the assistant call this tool result answers (OpenAI format). */
  toolCallId?: string
  /** Present on assistant turns that requested tools; must be echoed back. */
  toolCalls?: ToolCallRecord[]
  /** Tool-result status, for transcript restore. Providers ignore it. */
  ok?: boolean
  /** Diff produced by a write or edit, for transcript restore. Providers ignore it. */
  uiDiff?: { path: string; added: number; removed: number; lines: string[] }
  /** Marks a compaction summary, not a real user turn. Providers ignore it. */
  synthetic?: 'summary'
}

export interface ModelRef {
  id: string
  label: string
  contextWindow: number
}

export type ProviderEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'usage'
      promptTokens: number
      outputTokens: number
      cachedTokens: number
    }
  | { type: 'done'; reason: 'stop' | 'length' | 'cancelled' }

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools: ToolSchema[]
  /** Context window to request. Drives memory use and prefill cost. */
  numCtx: number
  think: boolean
  temperature?: number
  signal?: AbortSignal
}

export interface Provider {
  id: string
  listModels(): Promise<ModelRef[]>
  chat(request: ChatRequest): AsyncGenerator<ProviderEvent>
}
