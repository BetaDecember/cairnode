import { BrowserWindow } from 'electron'
import { runAgent } from '../core/agent/loop.ts'
import { compactConversation } from '../core/agent/compact.ts'
import { buildSystemPrompt } from '../core/agent/prompt.ts'
import { estimateMessagesTokens } from '../core/tokens.ts'
import { builtinTools } from '../core/tools/builtin.ts'
import type { ProviderId } from '../core/settings.ts'
import type { PermissionDecision, PermissionRequest } from '../core/agent/permission.ts'
import type { AgentEvent } from '../core/types.ts'
import type { ChatCompactInput, ChatSendInput } from '../core/api.ts'
import type { DiagnosticsLog } from '../core/diagnostics.ts'
import type { ChatMessage, Provider, ToolSchema } from '../core/provider/types.ts'
import type { SessionStore, SessionRecord } from '../core/session.ts'
import { providerFor, numCtxFor } from './providers.ts'
import type { SettingsStore } from './settings.ts'

/**
 * Owns in-flight agent runs and the permission round-trip.
 *
 * The loop is a pure generator; this class is the only place that knows about
 * windows, IPC, and the store. Keeping that split means the loop stays testable
 * with `node --test`.
 */

const DEFAULT_MODEL = 'qwen3.5:4b'
const DEFAULT_PROVIDER: ProviderId = 'ollama'
/** A prompt nobody answers should not pin a run forever. */
const PERMISSION_TIMEOUT_MS = 5 * 60_000

interface Run {
  controller: AbortController
}

/** Everything a run needs resolved from settings before the user message lands. */
interface Target {
  providerId: ProviderId
  provider: Provider
  model: string
  numCtx: number
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
  private readonly settings: SettingsStore
  private readonly runs = new Map<string, Run>()
  private readonly compacting = new Map<string, AbortController>()
  private readonly pending = new Map<string, PendingPermission>()
  private readonly diagnostics: DiagnosticsLog | null

  constructor(
    store: SessionStore,
    settings: SettingsStore,
    diagnostics: DiagnosticsLog | null = null,
  ) {
    this.store = store
    this.settings = settings
    this.diagnostics = diagnostics
  }

  async send(input: ChatSendInput): Promise<{ started: boolean }> {
    const sessionId = input.sessionId
    if (this.runs.has(sessionId)) {
      throw new Error('That session is already running.')
    }
    if (this.compacting.has(sessionId)) {
      throw new Error('Compaction is still running. Try again in a moment.')
    }

    // Reserve the session before the first await. Two sends arriving together
    // must not both pass the check and run the same history.
    const controller = new AbortController()
    this.runs.set(sessionId, { controller })

    try {
      const text = input.text.trim()
      if (!text) throw new Error('Message is empty.')

      // Resolve first: a disabled or misconfigured provider should fail before a
      // user message is persisted into a session that cannot answer.
      const target = await this.resolve(input)

      const record = await this.store.load(sessionId)
      if (!record) throw new Error('No such session.')
      if (controller.signal.aborted) throw new Error('The run was cancelled.')

      const userMessage: ChatMessage = { role: 'user', content: text }
      await this.store.append(sessionId, [userMessage])
      record.history.push(userMessage)

      void this.execute(input, target, record, controller).finally(() => {
        this.runs.delete(sessionId)
      })

      return { started: true }
    } catch (error) {
      this.runs.delete(sessionId)
      this.diagnostics?.record({
        kind: 'send_failed',
        sessionId,
        detail: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Compact on demand. Used by the composer when the context is getting full,
   * and never while a run is active: the run holds its own message array.
   */
  async compact(input: ChatCompactInput): Promise<{ compacted: boolean }> {
    const sessionId = input.sessionId
    if (this.runs.has(sessionId)) {
      throw new Error('Stop the run before compacting this session.')
    }
    if (this.compacting.has(sessionId)) {
      throw new Error('A compaction is already running.')
    }

    // Reserve before the first await, like send. A delete or quit can stop it.
    const controller = new AbortController()
    this.compacting.set(sessionId, controller)

    try {
      const target = await this.resolve(input)
      const record = await this.store.load(sessionId)
      if (!record) throw new Error('No such session.')
      if (record.history.length === 0) throw new Error('This session has nothing to compact yet.')

      const result = await compactConversation(record.history, {
        provider: target.provider,
        model: target.model,
        numCtx: target.numCtx,
        tools: toolSchemas(),
        signal: controller.signal,
      })

      await this.store.appendCompaction(sessionId, {
        at: new Date().toISOString(),
        summary: result.summary,
        task: result.task,
        dropped: result.dropped,
      })
      this.emit(sessionId, {
        type: 'compaction',
        summary: result.summary,
        task: result.task,
        dropped: result.dropped,
      })

      // The live meter should drop immediately; the next real turn replaces
      // this with provider-reported counts.
      const estimated = estimateMessagesTokens(
        [{ role: 'system', content: buildSystemPrompt() }, ...result.messages].map((message) => ({
          role: message.role,
          content: message.content,
        })),
      )
      this.emit(sessionId, {
        type: 'usage',
        usage: {
          promptTokens: estimated,
          outputTokens: 0,
          contextPct: Math.min(1, estimated / target.numCtx),
          contextWindow: target.numCtx,
          estimated: true,
          cachedTokens: 0,
        },
      })
      return { compacted: true }
    } catch (error) {
      // A session deleted while summarizing must not come back with a summary.
      if (controller.signal.aborted) return { compacted: false }
      this.diagnostics?.record({
        kind: 'compaction_failed',
        sessionId,
        detail: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      this.compacting.delete(sessionId)
    }
  }

  abort(sessionId: string): boolean {
    const run = this.runs.get(sessionId)
    const compaction = this.compacting.get(sessionId)
    if (!run && !compaction) return false

    // A summary that lands after the session is deleted would resurrect it.
    compaction?.abort()

    if (run) {
      // A run blocked on a permission prompt will never see the abort signal
      // unless the pending decision is released.
      for (const pending of this.pending.values()) {
        if (pending.sessionId === sessionId) pending.resolve('deny')
      }

      run.controller.abort()
    }

    return true
  }

  /** Whether an agent run is live in this process, regardless of what a window shows. */
  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  /** Whether this process is summarizing the session right now. */
  isCompacting(sessionId: string): boolean {
    return this.compacting.has(sessionId)
  }

  /**
   * Stop every run and summary in flight. Each abort releases pending
   * permission prompts and lets a running Bash tool kill its process group
   * before the window or app goes away.
   */
  abortAll(reason: 'window_closed' | 'quit' | 'suspend'): void {
    this.diagnostics?.record({ kind: 'abort_all', reason })
    for (const sessionId of [...this.runs.keys(), ...this.compacting.keys()]) {
      this.abort(sessionId)
    }
  }

  respond(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    pending.resolve(decision)
    return true
  }

  /**
   * Resolve the provider, model, and window from settings before a run starts.
   * Overrides from the composer win, but the provider itself must be enabled.
   */
  private async resolve(input: {
    providerId?: ProviderId
    model?: string
    numCtx?: number
  }): Promise<Target> {
    const providerId = input.providerId ?? DEFAULT_PROVIDER
    const settings = await this.settings.internal()
    const provider = providerFor(settings, providerId)
    const model = input.model?.trim() || (providerId === 'ollama' ? DEFAULT_MODEL : '')

    if (!model) throw new Error('Choose a model in the composer before running.')

    return {
      providerId,
      provider,
      model,
      numCtx: input.numCtx ?? numCtxFor(settings, providerId),
    }
  }

  private async execute(
    input: ChatSendInput,
    target: Target,
    record: SessionRecord,
    controller: AbortController,
  ): Promise<void> {
    const sessionId = input.sessionId

    try {
      for await (const event of runAgent({
        provider: target.provider,
        model: target.model,
        cwd: record.meta.cwd,
        numCtx: target.numCtx,
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
    if (event.type === 'error') {
      this.diagnostics?.record({
        kind: 'error',
        sessionId,
        errorClass: event.errorClass,
        retryable: event.retryable,
        detail: event.detail,
      })
    } else if (event.type === 'done') {
      this.diagnostics?.record({ kind: 'done', sessionId, stopReason: event.stopReason })
    }

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('agent:event', { sessionId, event })
    }
  }
}
