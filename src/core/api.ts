import type { AgentEvent, CompactionRecord, ModelInfo, PermissionMode, SessionMeta } from './types.ts'
import type { ProviderId, Settings, SettingsPatch } from './settings.ts'
import type { ChatMessage } from './provider/types.ts'
import type { PermissionDecision } from './agent/permission.ts'
import type { ProjectMemoryFile, ProjectMemoryWarning } from './memory-types.ts'
import type { TrustState } from './trust-types.ts'

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

/**
 * What the agent would load from the project root, plus whether the user has
 * reviewed and trusted that exact content.
 */
export interface ProjectMemoryStatus {
  cwd: string
  files: ProjectMemoryFile[]
  warnings: ProjectMemoryWarning[]
  /** Content identity used to bind trust to what was reviewed. Empty when there are no files. */
  fingerprint: string
  trust: TrustState
  bytes: number
  truncated: boolean
}

export interface SessionLoad {
  meta: SessionMeta
  messages: ChatMessage[]
  compactions: CompactionRecord[]
  /** The last turn stopped before a final assistant reply; safe to continue. */
  resumable: boolean
  /** A run for this session is still alive in main (e.g. the window reloaded). */
  running: boolean
  memory: ProjectMemoryStatus
}

export interface ChatSendInput {
  sessionId: string
  text: string
  mode?: PermissionMode
  providerId?: ProviderId
  model?: string
  numCtx?: number
  think?: boolean
}

export interface ChatCompactInput {
  sessionId: string
  providerId?: ProviderId
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

export interface DiagnosticsExport {
  /** Where the user chose to save the redacted report. */
  path: string
}

export interface RecodeApi {
  info(): Promise<AppInfo>
  models(): Promise<ModelInfo[]>
  settings: {
    get(): Promise<Settings>
    /** Persist a patch; returns the redacted settings the renderer may show. */
    save(patch: SettingsPatch): Promise<Settings>
  }
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
  memory: {
    /** Re-read the project's instruction files and the trust record. */
    status(sessionId: string): Promise<ProjectMemoryStatus>
    /**
     * Trust the instructions whose fingerprint was reviewed. Main re-reads and
     * refuses if the files changed in the meantime.
     */
    trust(input: { sessionId: string; fingerprint: string }): Promise<{
      trusted: boolean
      status: ProjectMemoryStatus
    }>
  }
  workspace: {
    pick(): Promise<string | null>
  }
  diagnostics: {
    /** Ask for a destination, then write the redacted support bundle. */
    export(): Promise<DiagnosticsExport | null>
  }
}
