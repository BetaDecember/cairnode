import type { ChatRequest, ModelRef, Provider, ProviderEvent } from './types.ts'
import { ProviderError, classifyStatus, normalizeArguments } from './common.ts'

/**
 * Ollama native API adapter.
 *
 * Uses `/api/chat` (not the OpenAI-compatible `/v1`) because it exposes
 * `message.thinking`, `prompt_eval_cached_count`, and `eval_count` — all of which
 * the UI depends on.
 */

interface RawToolCall {
  id?: string
  function?: { name?: string; arguments?: unknown }
}

interface RawChunk {
  message?: {
    role?: string
    content?: string
    thinking?: string
    tool_calls?: RawToolCall[]
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  prompt_eval_cached_count?: number
  eval_count?: number
  error?: string
}

interface RawTagsResponse {
  models?: Array<{ name?: string; model?: string; details?: { parameter_size?: string } }>
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama'
  private readonly baseUrl: string

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async listModels(): Promise<ModelRef[]> {
    const response = await this.request('/api/tags')
    const data = (await response.json()) as RawTagsResponse
    return (data.models ?? []).map((model) => ({
      id: model.name ?? model.model ?? 'unknown',
      label: model.name ?? model.model ?? 'unknown',
      // Filled in by probeModel; the list endpoint does not report it.
      contextWindow: 8192,
    }))
  }

  /** Context window and capabilities for one model. */
  async inspect(model: string): Promise<{ contextWindow: number; tools: boolean; thinking: boolean }> {
    const response = await this.request('/api/show', {
      method: 'POST',
      body: JSON.stringify({ model }),
    })
    const data = (await response.json()) as {
      model_info?: Record<string, unknown>
      capabilities?: string[]
    }

    let contextWindow = 8192
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
      if (key.endsWith('.context_length') && typeof value === 'number') {
        contextWindow = value
        break
      }
    }

    const capabilities = new Set(data.capabilities ?? [])
    return {
      contextWindow,
      tools: capabilities.has('tools'),
      thinking: capabilities.has('thinking'),
    }
  }

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    const body = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.thinking ? { thinking: message.thinking } : {}),
        ...(message.toolName ? { tool_name: message.toolName } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                function: { name: call.name, arguments: call.input },
              })),
            }
          : {}),
      })),
      tools: request.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      stream: true,
      think: request.think,
      options: {
        num_ctx: request.numCtx,
        temperature: request.temperature ?? 0.6,
      },
    }

    const response = await this.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: request.signal,
    })

    if (!response.body) {
      throw new ProviderError('network', 'The provider returned an empty response body.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line) continue

          const chunk = JSON.parse(line) as RawChunk
          if (chunk.error) throw new ProviderError('unknown', chunk.error)

          if (chunk.message?.thinking) {
            yield { type: 'thinking', text: chunk.message.thinking }
          }
          if (chunk.message?.content) {
            yield { type: 'text', text: chunk.message.content }
          }
          for (const call of chunk.message?.tool_calls ?? []) {
            yield {
              type: 'tool_call',
              id: call.id ?? crypto.randomUUID(),
              name: call.function?.name ?? '',
              input: normalizeArguments(call.function?.arguments),
            }
          }

          if (chunk.done) {
            yield {
              type: 'usage',
              promptTokens: chunk.prompt_eval_count ?? 0,
              outputTokens: chunk.eval_count ?? 0,
              cachedTokens: chunk.prompt_eval_cached_count ?? 0,
            }
            yield {
              type: 'done',
              reason: chunk.done_reason === 'length' ? 'length' : 'stop',
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new ProviderError('network', `Cannot reach Ollama at ${this.baseUrl}: ${detail}`)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ProviderError(
        classifyStatus(response.status),
        `HTTP ${response.status}: ${text.slice(0, 400)}`,
      )
    }
    return response
  }
}
