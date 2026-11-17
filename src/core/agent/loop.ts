import { randomUUID } from 'node:crypto'
import type { AgentEvent, ErrorClass, PermissionMode, TodoItem } from '../types.ts'
import type { ChatMessage, Provider } from '../provider/types.ts'
import { OllamaProvider } from '../provider/ollama.ts'
import { PermissionBroker } from './permission.ts'
import type { PermissionDecision, PermissionRequest } from './permission.ts'
import { buildSystemPrompt } from './prompt.ts'
import { compactConversation, microcompact } from './compact.ts'
import { toolByName } from '../tools/builtin.ts'
import type { Tool } from '../tools/types.ts'
import { contextFraction, estimateMessagesTokens } from '../tokens.ts'

export interface AgentRunOptions {
  model: string
  cwd: string
  numCtx: number
  think: boolean
  mode: PermissionMode
  conversation: ChatMessage[]
  provider?: Provider
  tools?: Tool[]
  signal?: AbortSignal
  /** Called when a tool needs an explicit decision. */
  ask?: (request: PermissionRequest) => Promise<PermissionDecision>
  /** Extra instructions appended to the system prompt, e.g. project memory. */
  projectMemory?: string
  /**
   * Called when history was replaced by a summary, so the host can persist the
   * boundary. Awaited before the run continues.
   */
  onCompaction?: (record: {
    at: string
    summary: string
    task: string
    dropped: number
  }) => void | Promise<void>
  /**
   * Called for every message the loop appends to history, including tool
   * results. Used to persist a session incrementally. Awaited, so a slow disk
   * applies backpressure instead of racing the transcript.
   */
  onMessage?: (message: ChatMessage) => void | Promise<void>
  maxTurns?: number
  /** Fraction of the context window at which the run stops cleanly. */
  contextCeiling?: number
  /** Fraction at which old tool output is replaced with stubs. */
  trimAt?: number
  /** Fraction at which the conversation is summarized. Defaults to the ceiling. */
  compactAt?: number
  /** Set false to keep the hard stop at the ceiling. */
  autoCompact?: boolean
}

/** How often the loop checks for buffered tool output while a tool is running. */
const PROGRESS_POLL_MS = 60

const ERROR_CLASSES: ReadonlySet<string> = new Set<ErrorClass>([
  'auth',
  'rate_limit',
  'overloaded',
  'context_overflow',
  'tool_unsupported',
  'network',
  'cancelled',
  'unknown',
])

/** Read the provider's own classification without trusting an `any` cast. */
function classifyError(error: unknown): { errorClass: ErrorClass; retryable: boolean } {
  if (error && typeof error === 'object') {
    const candidate = error as { errorClass?: unknown; retryable?: unknown }
    if (typeof candidate.errorClass === 'string' && ERROR_CLASSES.has(candidate.errorClass)) {
      return {
        errorClass: candidate.errorClass as ErrorClass,
        retryable: candidate.retryable === true,
      }
    }
  }
  return { errorClass: 'unknown', retryable: false }
}

function summarizeCall(tool: Tool, name: string, input: Record<string, unknown>): string {
  if (tool.summarize) return tool.summarize(input)
  if (name === 'Bash') return `$ ${String(input['command'] ?? '').slice(0, 160)}`
  for (const value of Object.values(input)) {
    if (typeof value === 'string') return value.slice(0, 160)
  }
  return name
}

/**
 * The agent loop. Pure: it takes a provider, tools, and a permission callback,
 * and yields a single event stream. It never touches Electron.
 *
 * Two invariants matter for performance on local models:
 *  - `messages` is append-only. Anything that rewrites an earlier message
 *    invalidates Ollama's KV cache and costs a full cold prefill.
 *  - Tool output is truncated by the tool, at insert time, never afterwards.
 */
export async function* runAgent(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
  const provider = options.provider ?? new OllamaProvider()
  const allTools = options.tools ?? []
  const maxTurns = options.maxTurns ?? 25
  const ceiling = options.contextCeiling ?? 0.85
  const compactAt = options.compactAt ?? ceiling
  const trimAt = options.trimAt ?? 0.6
  const autoCompact = options.autoCompact ?? true

  const toolSchemas = allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))

  const broker = new PermissionBroker(
    options.mode,
    options.ask ?? (async () => 'deny' as PermissionDecision),
  )

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(options.projectMemory) },
    ...options.conversation,
  ]

  /** Append a new message, and let the host persist it before continuing. */
  const append = async (message: ChatMessage): Promise<void> => {
    messages.push(message)
    if (options.onMessage) await options.onMessage(message)
  }

  const usageFor = (promptTokens: number, outputTokens: number, estimated: boolean, cached = 0) => ({
    promptTokens,
    outputTokens,
    contextPct: contextFraction(promptTokens + outputTokens, options.numCtx),
    contextWindow: options.numCtx,
    estimated,
    cachedTokens: cached,
  })

  let lastUsage = { promptTokens: 0, outputTokens: 0 }
  /**
   * Messages already covered by `lastUsage`. The assistant reply is counted by
   * `outputTokens`, so the index skips it; anything after (tool results) is the
   * delta the provider has not seen yet.
   */
  let countedThrough = 0
  let compactions = 0

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (options.signal?.aborted) {
        yield { type: 'done', stopReason: 'cancelled' }
        return
      }

      const estimated = estimateMessagesTokens(
        messages.map((message) => ({ role: message.role, content: message.content })),
      )
      // The last response's output is now part of the history, so it counts
      // toward the next prompt as well. Tool results were appended after that
      // response and are not in `prompt_eval_count`, so estimate the delta.
      const delta = lastUsage.promptTokens
        ? estimateMessagesTokens(
            messages
              .slice(countedThrough)
              .map((message) => ({ role: message.role, content: message.content })),
          )
        : 0
      const used = lastUsage.promptTokens
        ? lastUsage.promptTokens + lastUsage.outputTokens + delta
        : estimated
      let usedFraction = contextFraction(used, options.numCtx)

      // Tier 1: stub old tool output. Free, deterministic, and enough to keep
      // most sessions under the ceiling without a model call.
      if (usedFraction >= trimAt) {
        const trimmed = microcompact(messages.slice(1))
        if (trimmed.changed) {
          messages.splice(1, messages.length - 1, ...trimmed.messages)
          lastUsage = { promptTokens: 0, outputTokens: 0 }
          countedThrough = 0
          const next = estimateMessagesTokens(
            messages.map((message) => ({ role: message.role, content: message.content })),
          )
          usedFraction = contextFraction(next, options.numCtx)
          yield { type: 'usage', usage: usageFor(next, 0, true) }
        }
      }

      // Tier 2: one summarization pass. Rare, so the cache invalidation is
      // acceptable; after it the session continues instead of failing.
      if (usedFraction >= compactAt && autoCompact) {
        if (messages.length <= 2 || compactions >= 2) {
          yield {
            type: 'error',
            errorClass: 'context_overflow',
            retryable: false,
            detail: `Context is ${Math.round(usedFraction * 100)}% full of a ${options.numCtx.toLocaleString()}-token window, and there is nothing left to compact. Start a new session for this task.`,
          }
          yield { type: 'done', stopReason: 'context_full' }
          return
        }

        yield { type: 'session_state', state: 'compacting' }
        let result
        try {
          result = await compactConversation(messages.slice(1), {
            provider,
            model: options.model,
            numCtx: options.numCtx,
            tools: toolSchemas,
            signal: options.signal,
          })
        } catch (error) {
          if (options.signal?.aborted) {
            yield { type: 'done', stopReason: 'cancelled' }
            return
          }
          const detail = error instanceof Error ? error.message : String(error)
          yield {
            type: 'error',
            errorClass: 'context_overflow',
            retryable: false,
            detail: `Context is ${Math.round(usedFraction * 100)}% full of a ${options.numCtx.toLocaleString()}-token window. Compacting it failed: ${detail}`,
          }
          yield { type: 'done', stopReason: 'context_full' }
          return
        }

        const system = messages[0]
        if (!system) {
          yield { type: 'done', stopReason: 'error' }
          return
        }
        messages.splice(0, messages.length, system, ...result.messages)
        lastUsage = { promptTokens: 0, outputTokens: 0 }
        countedThrough = 0
        compactions += 1

        const at = new Date().toISOString()
        await options.onCompaction?.({
          at,
          summary: result.summary,
          task: result.task,
          dropped: result.dropped,
        })
        yield {
          type: 'compaction',
          summary: result.summary,
          task: result.task,
          dropped: result.dropped,
        }

        const next = estimateMessagesTokens(
          messages.map((message) => ({ role: message.role, content: message.content })),
        )
        usedFraction = contextFraction(next, options.numCtx)
        yield { type: 'usage', usage: usageFor(next, 0, true) }

        if (usedFraction >= ceiling) {
          yield {
            type: 'error',
            errorClass: 'context_overflow',
            retryable: false,
            detail: `Compaction left the context at ${Math.round(usedFraction * 100)}% of a ${options.numCtx.toLocaleString()}-token window. Raise the window or start a new session.`,
          }
          yield { type: 'done', stopReason: 'context_full' }
          return
        }
      }

      if (usedFraction >= ceiling) {
        yield {
          type: 'error',
          errorClass: 'context_overflow',
          retryable: false,
          detail: `Context is ${Math.round(usedFraction * 100)}% full of a ${options.numCtx.toLocaleString()}-token window. Start a new session for a long task.`,
        }
        yield { type: 'done', stopReason: 'context_full' }
        return
      }

      yield { type: 'session_state', state: 'thinking' }

      let text = ''
      let thinking = ''
      let lengthLimited = false
      const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

      for await (const event of provider.chat({
        model: options.model,
        messages,
        tools: toolSchemas,
        numCtx: options.numCtx,
        think: options.think,
        signal: options.signal,
      })) {
        switch (event.type) {
          case 'thinking':
            thinking += event.text
            yield { type: 'thinking_delta', text: event.text, source: 'native' }
            break
          case 'text':
            text += event.text
            yield { type: 'text_delta', text: event.text }
            break
          case 'tool_call':
            calls.push({
              id: event.id,
              name: event.name,
              input: (event.input ?? {}) as Record<string, unknown>,
            })
            break
          case 'usage':
            lastUsage = {
              promptTokens: event.promptTokens,
              outputTokens: event.outputTokens,
            }
            // The assistant message is appended below and already paid for by
            // `outputTokens`; the index points just past it.
            countedThrough = messages.length + 1
            yield {
              type: 'usage',
              usage: {
                promptTokens: event.promptTokens,
                outputTokens: event.outputTokens,
                contextPct: contextFraction(
                  event.promptTokens + event.outputTokens,
                  options.numCtx,
                ),
                contextWindow: options.numCtx,
                estimated: false,
                cachedTokens: event.cachedTokens,
              },
            }
            break
          case 'done':
            lengthLimited = event.reason === 'length'
            break
        }
      }

      if (calls.length === 0) {
        if (text.trim()) {
          await append({ role: 'assistant', content: text, thinking })
          yield { type: 'done', stopReason: lengthLimited ? 'max_tokens' : 'end_turn' }
          return
        }

        // Text is empty. Either the model only reasoned, or it hit the window.
        yield {
          type: 'error',
          errorClass: 'unknown',
          retryable: true,
          detail: lengthLimited
            ? 'The model ran out of room before writing a reply. Raise the context window or use a shorter task.'
            : 'The model returned no text and no tool calls. Try again, or phrase the task more concretely.',
        }
        yield { type: 'done', stopReason: lengthLimited ? 'max_tokens' : 'error' }
        return
      }

      yield { type: 'session_state', state: 'working' }
      await append({ role: 'assistant', content: text, thinking, toolCalls: calls })

      for (const call of calls) {
        const tool = toolByName(call.name)

        if (!tool) {
          yield {
            type: 'error',
            errorClass: 'tool_unsupported',
            retryable: false,
            detail: `The model called an unknown tool: ${call.name}.`,
          }
          await append({
            role: 'tool',
            toolName: call.name,
            ok: false,
            content: `Unknown tool: ${call.name}. Available tools: ${allTools.map((t) => t.name).join(', ')}.`,
          })
          continue
        }

        const request: PermissionRequest = {
          id: randomUUID(),
          tool: call.name,
          summary: summarizeCall(tool, call.name, call.input),
          risk: tool.risk,
        }

        yield {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
          summary: request.summary,
        }

        if (broker.requiresApproval(request)) {
          yield { type: 'session_state', state: 'awaiting_permission' }
          yield {
            type: 'permission_request',
            id: request.id,
            tool: request.tool,
            summary: request.summary,
            risk: request.risk,
          }
        }

        const allowed = await broker.check(request)

        if (!allowed) {
          yield {
            type: 'tool_result',
            id: call.id,
            ok: false,
            content: [{ type: 'text', text: 'Denied by the user.' }],
          }
          await append({
            role: 'tool',
            toolName: call.name,
            ok: false,
            content: 'Denied by the user.',
          })
          yield { type: 'session_state', state: 'working' }
          continue
        }

        if (call.name === 'TodoWrite') {
          yield { type: 'todo_update', items: toTodoItems(call.input['items']) }
        }

        // Tool execution is awaited, so buffered output is drained here and
        // yielded while the tool is still running. The buffer belongs to this
        // call — never to the module — so concurrent runs cannot cross-talk.
        const buffer: string[] = []
        const state: { settled: boolean; failed: boolean; error: unknown } = {
          settled: false,
          failed: false,
          error: null,
        }

        let notifySettled: () => void = () => {}
        const settledSignal = new Promise<void>((resolve) => {
          notifySettled = resolve
        })

        const markSettled = () => {
          state.settled = true
          notifySettled()
        }

        const running = tool.execute(call.input, {
          cwd: options.cwd,
          signal: options.signal,
          onProgress: (chunk) => buffer.push(chunk),
        })
        void running.then(markSettled, (error: unknown) => {
          state.failed = true
          state.error = error
          markSettled()
        })

        while (!state.settled) {
          if (buffer.length > 0) {
            yield { type: 'tool_progress', id: call.id, chunk: buffer.splice(0).join('') }
            continue
          }
          await Promise.race([
            new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS)),
            settledSignal,
          ])
        }

        if (buffer.length > 0) {
          yield { type: 'tool_progress', id: call.id, chunk: buffer.splice(0).join('') }
        }

        if (state.failed) {
          const detail =
            state.error instanceof Error ? state.error.message : String(state.error)
          yield {
            type: 'tool_result',
            id: call.id,
            ok: false,
            content: [{ type: 'text', text: detail }],
          }
          await append({
            role: 'tool',
            toolName: call.name,
            ok: false,
            content: `Error: ${detail}`,
          })
          yield { type: 'session_state', state: 'working' }
          continue
        }

        const result = await running

        yield {
          type: 'tool_result',
          id: call.id,
          ok: result.ok,
          content: [{ type: 'text', text: result.content }],
        }

        if (result.diff) {
          yield {
            type: 'tool_diff',
            id: call.id,
            path: result.diff.path,
            added: result.diff.added,
            removed: result.diff.removed,
            lines: result.diff.lines,
          }
        }

        await append({
          role: 'tool',
          toolName: call.name,
          ok: result.ok,
          uiDiff: result.diff,
          content: result.content,
        })
        yield { type: 'session_state', state: 'working' }
      }
    }

    yield {
      type: 'error',
      errorClass: 'unknown',
      retryable: false,
      detail: `Stopped after ${maxTurns} turns without finishing.`,
    }
    yield { type: 'done', stopReason: 'max_tokens' }
  } catch (error) {
    if (options.signal?.aborted) {
      yield { type: 'done', stopReason: 'cancelled' }
      return
    }

    const { errorClass, retryable } = classifyError(error)
    yield {
      type: 'error',
      errorClass,
      retryable,
      detail: error instanceof Error ? error.message : String(error),
    }
    yield { type: 'done', stopReason: 'error' }
  }
}

function toTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>
    const status = record['status']
    return {
      id: `todo-${index}`,
      text: String(record['text'] ?? ''),
      status:
        status === 'done' || status === 'in_progress' || status === 'pending' ? status : 'pending',
    }
  })
}
