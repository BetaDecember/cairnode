import { BrowserWindow } from 'electron'
import { runAgent } from '../core/agent/loop.ts'
import { compactConversation } from '../core/agent/compact.ts'
import { buildSystemPrompt } from '../core/agent/prompt.ts'
import { estimateMessagesTokens } from '../core/tokens.ts'
import { builtinTools } from '../core/tools/builtin.ts'
import { OllamaProvider } from '../core/provider/ollama.ts'
import type { PermissionDecision, PermissionRequest } from '../core/agent/permission.ts'
import type { AgentEvent } from '../core/types.ts'
import type { ChatCompactInput, ChatSendInput } from '../core/api.ts'
import type { ChatMessage, ToolSchema } from '../core/provider/types.ts'
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

function toolSchemas(): ToolSchema[] {
  return builtinTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

export class AgentHost {
  private readonly store: SessionStore
  private readonly runs = new Map<string, Run>()
  private readonly compacting = new Set<string>()
  private readonly pending = new Map<string, PendingPermission>()

  constructor(store: SessionStore) {
    this.store = store
  }

  async send(input: ChatSendInput): Promise<{ started: boolean }> {
    if (this.runs.has(input.sessionId)) {
      throw new Error('That session is already running.')
    }
    if (this.compacting.has(input.sessionId)) {
      throw new Error('Compaction is still running. Try again in a moment.')
    }

    const text = input.text.trim()
    if (!text) throw new Error('Message is empty.')

    const record = await this.store.load(input.sessionId)
    if (!record) throw new Error('No such session.')

    const userMessage: ChatMessage = { role: 'user', content: text }
    await this.store.append(input.sessionId, [userMessage])
    record.history.push(userMessage)

    const controller = new AbortController()
    this.runs.set(input.sessionId, { controller })

    void this.execute(input, record, controller).finally(() => {
      this.runs.delete(input.sessionId)
    })

    return { started: true }
  }

  /**
   * Compact on demand. Used by the composer when the context is getting full,
   * and never while a run is active: the run holds its own message array.
   */
  async compact(input: ChatCompactInput): Promise<{ compacted: boolean }> {
    if (this.runs.has(input.sessionId) || this.compacting.has(input.sessionId)) {
      throw new Error('Stop the run before compacting this session.')
    }

    const record = await this.store.load(input.sessionId)
    if (!record) throw new Error('No such session.')
    if (record.history.length === 0) throw new Error('This session has nothing to compact yet.')

    this.compacting.add(input.sessionId)
    try {
      const result = await compactConversation(record.history, {
        provider: new OllamaProvider(),
        model: input.model ?? DEFAULT_MODEL,
        numCtx: input.numCtx ?? DEFAULT_NUM_CTX,
        tools: toolSchemas(),
      })

      await this.store.appendCompaction(input.sessionId, {
        at: new Date().toISOString(),
        summary: result.summary,
        task: result.task,
        dropped: result.dropped,
      })
      this.emit(input.sessionId, {
        type: 'compaction',
        summary: result.summary,
        task: result.task,
        dropped: result.dropped,
      })

      // The live meter should drop immediately; the next real turn replaces
      // this with provider-reported counts.
      const numCtx = input.numCtx ?? DEFAULT_NUM_CTX
      const estimated = estimateMessagesTokens(
        [{ role: 'system', content: buildSystemPrompt() }, ...result.messages].map((message) => ({
          role: message.role,
          content: message.content,
        })),
      )
      this.emit(input.sessionId, {
        type: 'usage',
        usage: {
          promptTokens: estimated,
          outputTokens: 0,
          contextPct: Math.min(1, estimated / numCtx),
          contextWindow: numCtx,
          estimated: true,
          cachedTokens: 0,
        },
      })
      return { compacted: true }
    } finally {
      this.compacting.delete(input.sessionId)
    }
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
        conversation: record.history,
        tools: builtinTools,
        signal: controller.signal,
        ask: (request) => this.ask(sessionId, request),
        // Persist each message as it lands, so a crash costs one turn at most.
        onMessage: (message) => this.store.append(sessionId, [message]),
        // A summary replaces history for the model, never for the transcript.
        onCompaction: (record) => this.store.appendCompaction(sessionId, record),
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
