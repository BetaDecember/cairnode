import type { ChatMessage, Provider, ToolSchema } from '../provider/types.ts'
import { estimateMessagesTokens, estimateTokens } from '../tokens.ts'

/**
 * Context management.
 *
 * Two tiers, in order of cost:
 *  1. Microcompact rewrites old, large tool results into stubs. Free and
 *     deterministic, but it still invalidates the KV-cache prefix once.
 *  2. Compaction asks the model for a handoff summary, then replaces the
 *     conversation with that summary plus the active user task. One pass,
 *     rarely, and visibly announced in the transcript.
 *
 * The active task is kept verbatim: a summary alone makes the model answer its
 * own summary instead of continuing the work.
 */

export const SUMMARY_PREFIX = 'Summary of earlier work in this session:'

/** Tool output longer than this is eligible for stubbing when it is old. */
const STUB_AT_CHARS = 1200
const KEEP_RECENT_TOOL_RESULTS = 4

export interface MicrocompactOptions {
  /** Most recent tool results to leave untouched. */
  keepRecent?: number
  /** Results shorter than this are already cheap and stay intact. */
  stubAt?: number
}

export interface MicrocompactResult {
  messages: ChatMessage[]
  changed: boolean
  savedChars: number
}

/** Replace old, large tool output with a short stub. Newest results stay exact. */
export function microcompact(
  messages: ChatMessage[],
  options: MicrocompactOptions = {},
): MicrocompactResult {
  const keepRecent = options.keepRecent ?? KEEP_RECENT_TOOL_RESULTS
  const stubAt = options.stubAt ?? STUB_AT_CHARS

  const toolPositions: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'tool') toolPositions.push(index)
  })
  const firstKept =
    keepRecent > 0 ? (toolPositions.at(-keepRecent) ?? messages.length) : messages.length

  let savedChars = 0
  const next = messages.map((message, index): ChatMessage => {
    if (index >= firstKept || message.role !== 'tool') return message
    if (message.content.length <= stubAt) return message

    const head = message.content.slice(0, 240).trimEnd()
    const removed = message.content.length - head.length
    savedChars += removed
    return {
      ...message,
      content: `${head}\n… [${message.toolName ?? 'tool'} output trimmed: ${removed} characters removed to save context]`,
    }
  })

  return { messages: next, changed: savedChars > 0, savedChars }
}

/** Mark a message as a compaction summary so the model's history stays legible. */
export function summaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}`, synthetic: 'summary' }
}

/** The instruction the agent must keep working on: the last real user message. */
export function activeTask(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user' && message.synthetic !== 'summary') return message.content
  }
  return ''
}

/**
 * Whether the conversation ends with work in progress.
 *
 * Mid-run, the latest user instruction has no final reply yet. It is kept
 * verbatim after the summary so the model continues instead of answering its
 * own summary. After a completed turn, repeating the instruction makes the
 * model redo the work, so it is dropped.
 */
export function endsMidWork(messages: ChatMessage[]): boolean {
  const last = messages.at(-1)
  if (!last) return false
  if (last.role === 'assistant') return (last.toolCalls?.length ?? 0) > 0
  return last.role === 'user' || last.role === 'tool'
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

function describeMessage(message: ChatMessage): string {
  if (message.role === 'user') {
    return `USER:\n${clip(message.content, 4000)}`
  }

  if (message.role === 'tool') {
    return `TOOL ${message.toolName ?? ''} (${message.ok === false ? 'failed' : 'ok'}):\n${clip(message.content, 800)}`
  }

  if (message.role === 'assistant') {
    const parts = ['ASSISTANT:']
    // Qwen-family models often put all of the rationale in `thinking` and leave
    // the visible content empty. The end of the thought is the decision.
    if (message.thinking) parts.push(`THOUGHT:\n${tail(message.thinking, 700)}`)
    if (message.content.trim()) parts.push(clip(message.content, 1600))
    if (message.toolCalls?.length) {
      const calls = message.toolCalls.map(
        (call) => `${call.name}(${clip(JSON.stringify(call.input ?? {}), 240)})`,
      )
      parts.push(`CALLED: ${calls.join('; ')}`)
    }
    return parts.join('\n')
  }

  return `${message.role.toUpperCase()}:\n${clip(message.content, 800)}`
}

/**
 * A bounded transcript for the summarizer, newest messages first, with the
 * original user task prepended when the cutoff drops it.
 */
export function buildSummaryInput(messages: ChatMessage[], budgetTokens: number): string {
  const budgetChars = Math.max(4000, Math.floor(budgetTokens * 3.5))
  const blocks = messages.map(describeMessage)

  let start = blocks.length
  let used = 0
  while (start > 0) {
    const block = blocks[start - 1] ?? ''
    const cost = block.length + 2
    if (used + cost > budgetChars) {
      if (start === blocks.length) {
        // The newest message alone exceeds the budget; keep its head.
        blocks[start - 1] = clip(block, budgetChars)
        used = budgetChars
        start -= 1
      }
      break
    }
    used += cost
    start -= 1
  }

  const firstUser = messages.find(
    (message) => message.role === 'user' && message.synthetic !== 'summary',
  )
  const omitted = start
  const head =
    omitted > 0 && firstUser
      ? `[${omitted} earlier messages omitted]\n\nORIGINAL TASK:\n${clip(firstUser.content, 2000)}\n\n`
      : ''

  return head + blocks.slice(start).join('\n\n')
}

const SUMMARY_INSTRUCTION = `You are compacting a coding session so the same agent can continue the work in a fresh context.
Write a handoff summary under 400 words. Include:
- the user's task and any constraints
- files read or changed, with paths
- commands run and what they showed
- decisions made and why
- what is still open or unverified
Do not call tools. Do not invent details. Reply with the summary only.`

export interface SummarizeOptions {
  provider: Provider
  model: string
  numCtx: number
  /** Same schemas as the agent run, so the cached prompt prefix is reused. */
  tools?: ToolSchema[]
  signal?: AbortSignal
}

/**
 * Ask the model for a handoff summary.
 *
 * The instruction is appended to the live conversation instead of flattening it:
 * on Ollama that reuses the KV-cache prefix, turning a multi-minute cold prefill
 * into a normal generation. If the prompt is already near the window, fall back
 * to a bounded transcript.
 */
export async function summarizeConversation(
  conversation: ChatMessage[],
  options: SummarizeOptions,
): Promise<string> {
  const instruction: ChatMessage = { role: 'user', content: SUMMARY_INSTRUCTION }
  const bounded = microcompact(conversation, { keepRecent: 2, stubAt: 600 }).messages

  const appendFits =
    estimateMessagesTokens(
      bounded.map((message) => ({ role: message.role, content: message.content })),
    ) +
      estimateTokens(SUMMARY_INSTRUCTION) +
      512 <
    options.numCtx

  const messages: ChatMessage[] = appendFits
    ? [...bounded, instruction]
    : [
        {
          role: 'user',
          content: `${SUMMARY_INSTRUCTION}\n\n--- SESSION TRANSCRIPT ---\n\n${buildSummaryInput(
            conversation,
            Math.floor(options.numCtx * 0.55),
          )}`,
        },
      ]

  let summary = ''
  for await (const event of options.provider.chat({
    model: options.model,
    messages,
    tools: appendFits ? (options.tools ?? []) : [],
    numCtx: options.numCtx,
    think: false,
    temperature: 0,
    signal: options.signal,
  })) {
    if (event.type === 'text') summary += event.text
  }

  const clean = summary.trim()
  if (!clean) throw new Error('The model returned an empty summary.')

  const maxChars = Math.max(2400, Math.floor(options.numCtx * 0.2 * 3.5))
  return clip(clean, maxChars)
}

export interface CompactionResult {
  summary: string
  task: string
  /** Conversation messages replaced by the summary. */
  dropped: number
  messages: ChatMessage[]
}

/** Summarize the conversation and return the replacement history. */
export async function compactConversation(
  conversation: ChatMessage[],
  options: SummarizeOptions,
): Promise<CompactionResult> {
  const summary = await summarizeConversation(conversation, options)
  const task = endsMidWork(conversation) ? activeTask(conversation) : ''
  const messages: ChatMessage[] = [summaryMessage(summary)]
  if (task.trim()) messages.push({ role: 'user', content: task })

  return { summary, task, dropped: conversation.length, messages }
}
