import { BrowserWindow } from 'electron'
import { runAgent } from '../core/agent/loop.ts'
import { builtinTools } from '../core/tools/builtin.ts'
import type { PermissionDecision, PermissionRequest } from '../core/agent/permission.ts'
import type { AgentEvent } from '../core/types.ts'
import type { ChatSendInput } from '../core/api.ts'
import type { ChatMessage } from '../core/provider/types.ts'
import type { SessionStore, SessionRecord } from '../core/session.ts'

/**
 * Owns in-flight agent runs and the permission round-trip.
 *
 * The loop is a pure generator; this class is the only place that knows about
 * windows, IPC, and the store. Keeping that split means the loop stays testable
 * with `node --test`.
 */

const DEFAULT_MODEL = 'qwen3.5:4b'
const DEFAULT_NUM_CTX = 8192
/** A prompt nobody answers should not pin a run forever. */
const PERMISSION_TIMEOUT_MS = 5 * 60_000

interface Run {
  controller: AbortController
}

interface PendingPermission {
  sessionId: string
  resolve: (decision: PermissionDecision) => void
}

export class AgentHost {
  private readonly store: SessionStore
  private readonly runs = new Map<string, Run>()
  private readonly pending = new Map<string, PendingPermission>()

  constructor(store: SessionStore) {
    this.store = store
  }

  async send(input: ChatSendInput): Promise<{ started: boolean }> {
    if (this.runs.has(input.sessionId)) {
      throw new Error('That session is already running.')
    }

    const text = input.text.trim()
    if (!text) throw new Error('Message is empty.')

    const record = await this.store.load(input.sessionId)
    if (!record) throw new Error('No such session.')

    const userMessage: ChatMessage = { role: 'user', content: text }
    await this.store.append(input.sessionId, [userMessage])
    record.messages.push(userMessage)

    const controller = new AbortController()
    this.runs.set(input.sessionId, { controller })

    void this.execute(input, record, controller).finally(() => {
      this.runs.delete(input.sessionId)
    })

    return { started: true }
  }

  abort(sessionId: string): boolean {
    const run = this.runs.get(sessionId)
    if (!run) return false

    // A run blocked on a permission prompt will never see the abort signal
    // unless the pending decision is released.
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) pending.resolve('deny')
    }

    run.controller.abort()
    return true
  }

  respond(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    pending.resolve(decision)
    return true
  }

  private async execute(
    input: ChatSendInput,
    record: SessionRecord,
    controller: AbortController,
  ): Promise<void> {
    const sessionId = input.sessionId

    try {
      for await (const event of runAgent({
        model: input.model ?? DEFAULT_MODEL,
        cwd: record.meta.cwd,
        numCtx: input.numCtx ?? DEFAULT_NUM_CTX,
        think: input.think ?? true,
        mode: input.mode ?? 'default',
        conversation: record.messages,
        tools: builtinTools,
        signal: controller.signal,
        ask: (request) => this.ask(sessionId, request),
        // Persist each message as it lands, so a crash costs one turn at most.
        onMessage: (message) => this.store.append(sessionId, [message]),
      })) {
        this.emit(sessionId, event)
      }
    } catch (error) {
      this.emit(sessionId, {
        type: 'error',
        errorClass: 'unknown',
        retryable: false,
        detail:
          error instanceof Error
            ? `The session stopped unexpectedly: ${error.message}`
            : 'The session stopped unexpectedly.',
      })
      this.emit(sessionId, { type: 'done', stopReason: 'error' })
    }
  }

  private ask(sessionId: string, request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (decision: PermissionDecision) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.pending.delete(request.id)
        resolve(decision)
      }

      timer = setTimeout(() => finish('deny'), PERMISSION_TIMEOUT_MS)
      this.pending.set(request.id, { sessionId, resolve: finish })
    })
  }

  private emit(sessionId: string, event: AgentEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('agent:event', { sessionId, event })
    }
  }
}
