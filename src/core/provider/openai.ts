import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, ModelRef, Provider, ProviderEvent } from './types.ts'
import {
  ProviderError,
  classifyStatus,
  normalizeArguments,
  parseRetryAfter,
} from './common.ts'

/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * One code path covers LM Studio, llama.cpp server, vLLM, Groq, Together,
 * OpenRouter, and OpenAI itself. The base URL is whatever comes before
 * `/chat/completions` — including the `/v1` segment.
 *
 * Compared with the Ollama adapter this stream is less generous: usage is only
 * present when the server honors `stream_options`, reasoning has no standard
 * field name, and tool arguments arrive in fragments. All three are handled
 * defensively; anything missing falls back to the loop's estimates.
 */

interface RawToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface RawDelta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  thinking?: string | null
  tool_calls?: RawToolCallDelta[]
}

interface RawChunk {
  choices?: Array<{ delta?: RawDelta; finish_reason?: string | null }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
  } | null
  error?: { message?: string } | string
}

interface RawModels {
  data?: Array<{ id?: string }>
}

export interface OpenAIOptions {
  baseUrl: string
  apiKey?: string
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export class OpenAIProvider implements Provider {
  readonly id = 'openai'
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAIOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey ?? ''
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async listModels(): Promise<ModelRef[]> {
    const response = await this.request('/models', { method: 'GET' })
    const data = (await response.json()) as RawModels
    return (data.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({
        id,
        label: id,
        // Chat Completions does not expose a context window; the caller's
        // configured request size is used instead.
        contextWindow: 8192,
      }))
  }

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    // `numCtx` and `think` are Ollama-specific knobs. Chat Completions has no
    // portable equivalent, so the server's own configuration decides both.
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? 0.6,
    }
    if (request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
      body['tool_choice'] = 'auto'
    }

    let response: Response
    try {
      response = await this.request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: request.signal,
      })
    } catch (error) {
      // A few local servers predate stream_options and reject the whole request
      // because of it. Usage is optional; the turn is not.
      if (error instanceof ProviderError && error.message.includes('stream_options')) {
        delete body['stream_options']
        response = await this.request('/chat/completions', {
          method: 'POST',
          body: JSON.stringify(body),
          signal: request.signal,
        })
      } else {
        throw error
      }
    }

    if (!response.body) {
      throw new ProviderError('network', 'The provider returned an empty response body.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const calls = new Map<number, { id?: string; name: string; arguments: string }>()
    let finishReason = 'stop'
    // Held in an object because the stream handlers below are closures, and
    // TypeScript's narrowing does not track assignments made inside them.
    const state: { usage: NonNullable<RawChunk['usage']> | null } = { usage: null }

    const handleLine = (line: string): { done: boolean; events: ProviderEvent[] } => {
      const events: ProviderEvent[] = []
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
        return { done: false, events }
      }

      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return { done: true, events }

      let chunk: RawChunk
      try {
        chunk = JSON.parse(payload) as RawChunk
      } catch {
        throw new ProviderError('unknown', `Malformed stream chunk: ${payload.slice(0, 200)}`)
      }

      if (chunk.error) {
        const detail = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? '')
        throw new ProviderError('unknown', detail || 'The provider reported an error mid-stream.')
      }

      if (chunk.usage) state.usage = chunk.usage

      const choice = chunk.choices?.[0]
      if (!choice) return { done: false, events }

      if (choice.finish_reason) finishReason = choice.finish_reason

      const delta = choice.delta
      if (!delta) return { done: false, events }

      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking
      if (reasoning) events.push({ type: 'thinking', text: reasoning })
      if (delta.content) events.push({ type: 'text', text: delta.content })

      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? 0
        const entry = calls.get(index) ?? { name: '', arguments: '' }
        if (part.id) entry.id = part.id
        if (part.function?.name) entry.name += part.function.name
        if (part.function?.arguments) entry.arguments += part.function.arguments
        calls.set(index, entry)
      }

      return { done: false, events }
    }

    try {
      let finished = false
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')

          const result = handleLine(line)
          if (result.done) {
            finished = true
            buffer = ''
            break
          }
          for (const event of result.events) yield event
        }
      }

      // Some servers close without a trailing newline.
      if (buffer.trim()) {
        const result = handleLine(buffer)
        for (const event of result.events) yield event
      }
    } finally {
      reader.releaseLock()
    }

    const ordered = [...calls.entries()].sort(([a], [b]) => a - b)
    for (const [, call] of ordered) {
      if (!call.name) continue
      yield {
        type: 'tool_call',
        id: call.id ?? randomUUID(),
        name: call.name,
        input: normalizeArguments(call.arguments),
      }
    }

    const usage = state.usage
    if (usage) {
      yield {
        type: 'usage',
        promptTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens:
          usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
      }
    }

    yield { type: 'done', reason: finishReason === 'length' ? 'length' : 'stop' }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new ProviderError('network', `Cannot reach ${this.baseUrl}: ${detail}`)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // 400 is ambiguous across compatible servers: it can mean a bad tool
      // schema, a bad model name, or an unsupported option. Show the raw body.
      throw new ProviderError(
        classifyStatus(response.status),
        `HTTP ${response.status}: ${text.slice(0, 400)}`,
        { retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) },
      )
    }
    return response
  }
}

/** Tool results must carry the id of the call they answer. */
function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      }
    }

    if (message.role === 'assistant') {
      const mapped: Record<string, unknown> = {
        role: 'assistant',
        content: message.content || null,
      }
      if (message.toolCalls?.length) {
        mapped['tool_calls'] = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input ?? {}),
          },
        }))
      }
      return mapped
    }

    return { role: message.role, content: message.content }
  })
}
