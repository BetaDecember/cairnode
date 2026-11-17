import type { AgentEvent, CompactionRecord, ModelInfo, PermissionMode, SessionMeta } from './types.ts'
import type { ChatMessage } from './provider/types.ts'
import type { PermissionDecision } from './agent/permission.ts'

/**
 * The contract between the main process and the renderer.
 *
 * Kept in `core` so both sides can import the same declaration without the
 * renderer pulling in Electron types.
 */

export interface AppInfo {
  version: string
  platform: string
  arch: string
  electron: string
  node: string
  isDev: boolean
}

export interface SessionLoad {
  meta: SessionMeta
  messages: ChatMessage[]
  compactions: CompactionRecord[]
}

export interface ChatSendInput {
  sessionId: string
  text: string
  mode?: PermissionMode
  model?: string
  numCtx?: number
  think?: boolean
}

export interface ChatCompactInput {
  sessionId: string
  model?: string
  numCtx?: number
}

export interface AgentStreamPayload {
  sessionId: string
  event: AgentEvent
}

export interface PermissionRespondInput {
  requestId: string
  decision: PermissionDecision
}

export interface RecodeApi {
  info(): Promise<AppInfo>
  models(): Promise<ModelInfo[]>
  sessions: {
    list(): Promise<SessionMeta[]>
    create(cwd?: string): Promise<SessionMeta>
    load(id: string): Promise<SessionLoad | null>
    remove(id: string): Promise<void>
  }
  chat: {
    send(input: ChatSendInput): Promise<{ started: boolean }>
    abort(sessionId: string): Promise<void>
    /** Summarize the session history now, then keep going from that summary. */
    compact(input: ChatCompactInput): Promise<{ compacted: boolean }>
    respond(input: PermissionRespondInput): Promise<boolean>
    /** Returns an unsubscribe function. */
    onEvent(callback: (payload: AgentStreamPayload) => void): () => void
  }
  workspace: {
    pick(): Promise<string | null>
  }
}
