import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIProvider } from './openai.ts'
import { ProviderError } from './common.ts'
import type { ChatRequest, ProviderEvent } from './types.ts'

/**
 * Recorded-shape fixtures for the OpenAI-compatible adapter.
 *
 * The interesting part of this protocol is what arrives fragmented: SSE lines
 * can split mid-JSON at any byte, and tool arguments always do. The fake
 * transport below emits one scripted `Response` per call, in order.
 */

interface Call {
  url: string
  init: RequestInit
}

type FakeFetch = typeof fetch & { calls: Call[] }

function fakeFetch(responses: Array<Response | (() => Response)>): FakeFetch {
  const calls: Call[] = []
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('No scripted response left')
    return typeof next === 'function' ? next() : next
  }
  return Object.assign(impl as typeof fetch, { calls })
}

/** A streaming response whose body is cut into fixed-size pieces. */
function streamResponse(text: string, chunkSize = 7, status = 200): Response {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        controller.enqueue(bytes.slice(at, at + chunkSize))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function sse(...lines: string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join('')
}

async function collect(provider: OpenAIProvider, request: ChatRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const event of provider.chat(request)) events.push(event)
  return events
}

const base: ChatRequest = {
  model: 'local-model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  numCtx: 8192,
  think: false,
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

describe('OpenAIProvider', () => {
  it('streams reasoning, text, and usage across fragmented chunks', async () => {
    const raw = sse(
      '{"choices":[{"delta":{"reasoning_content":"Let me "}}]}',
      '{"choices":[{"delta":{"reasoning_content":"think."}}]}',
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      '{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":64}}}',
      '[DONE]',
    )
    const transport = fakeFetch([streamResponse(raw, 3)])
    const events = await collect(
      new OpenAIProvider({ baseUrl: 'http://127.0.0.1:1234/v1', fetchImpl: transport }),
      base,
    )

    assert.deepEqual(events, [
      { type: 'thinking', text: 'Let me ' },
      { type: 'thinking', text: 'think.' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'usage', promptTokens: 120, outputTokens: 8, cachedTokens: 64 },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('accepts the common reasoning field aliases', async () => {
    const raw = sse(
      '{"choices":[{"delta":{"reasoning":"a"}}]}',
      '{"choices":[{"delta":{"thinking":"b"}}]}',
      '{"choices":[{"delta":{"content":"c"},"finish_reason":"stop"}]}',
      '[DONE]',
    )
    const transport = fakeFetch([streamResponse(raw, 1024)])
    const events = await collect(
      new OpenAIProvider({ baseUrl: 'http://127.0.0.1:1234/v1', fetchImpl: transport }),
      base,
    )

    assert.deepEqual(events.slice(0, 3), [
      { type: 'thinking', text: 'a' },
      { type: 'thinking', text: 'b' },
      { type: 'text', text: 'c' },
    ])
  })

  it('assembles fragmented tool calls in index order', async () => {
    const raw = sse(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"Read","arguments":""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"src/a.ts\\"}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"Glob","arguments":"{\\"pattern\\":\\"**/*.ts\\"}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    )
    const transport = fakeFetch([streamResponse(raw, 11)])
    const events = await collect(
      new OpenAIProvider({ baseUrl: 'http://127.0.0.1:1234/v1', fetchImpl: transport }),
      base,
    )

    assert.deepEqual(events, [
      { type: 'tool_call', id: 'call_a', name: 'Read', input: { path: 'src/a.ts' } },
      { type: 'tool_call', id: 'call_b', name: 'Glob', input: { pattern: '**/*.ts' } },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('maps history, tools, and auth onto the request', async () => {
    const transport = fakeFetch([streamResponse(sse('[DONE]'))])
    const provider = new OpenAIProvider({
      baseUrl: 'http://127.0.0.1:1234/v1/',
      apiKey: 'sk-test',
      fetchImpl: transport,
    })

    const events = await collect(provider, {
      ...base,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Add multiply' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_a', name: 'Read', input: { path: 'a.ts' } }],
        },
        { role: 'tool', toolName: 'Read', toolCallId: 'call_a', content: 'file body' },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      ],
    })

    const call = transport.calls[0]
    assert.ok(call)
    assert.equal(call.url, 'http://127.0.0.1:1234/v1/chat/completions')
    assert.equal(String(call.init.method), 'POST')
    assert.equal(
      (call.init.headers as Record<string, string>)['authorization'],
      'Bearer sk-test',
    )

    const body = bodyOf(call)
    assert.equal(body['model'], 'local-model')
    assert.equal(body['stream'], true)
    assert.deepEqual(body['stream_options'], { include_usage: true })
    assert.equal(body['temperature'], 0.6)

    const messages = body['messages'] as Array<Record<string, unknown>>
    const assistant = messages[2]
    assert.ok(assistant)
    assert.equal(assistant['content'], null)
    const toolCalls = assistant['tool_calls'] as Array<Record<string, unknown>>
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0]?.['id'], 'call_a')
    const fn = toolCalls[0]?.['function'] as Record<string, unknown>
    assert.equal(fn['name'], 'Read')
    assert.equal(fn['arguments'], '{"path":"a.ts"}')

    const result = messages[3]
    assert.ok(result)
    assert.equal(result['role'], 'tool')
    assert.equal(result['tool_call_id'], 'call_a')
    assert.equal(result['content'], 'file body')

    const tools = body['tools'] as Array<Record<string, unknown>>
    assert.equal(tools.length, 1)
    const tool = tools[0]?.['function'] as Record<string, unknown>
    assert.equal(tool['name'], 'Read')

    assert.deepEqual(events, [{ type: 'done', reason: 'stop' }])
  })

  it('retries once without stream_options when a server rejects it', async () => {
    const transport = fakeFetch([
      new Response('unknown field: stream_options', { status: 400 }),
      streamResponse(
        sse(
          '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ])
    const provider = new OpenAIProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      fetchImpl: transport,
    })

    const events = await collect(provider, base)

    assert.equal(transport.calls.length, 2)
    assert.ok('stream_options' in bodyOf(transport.calls[0]!))
    assert.ok(!('stream_options' in bodyOf(transport.calls[1]!)))
    assert.deepEqual(events, [
      { type: 'text', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('maps 429 onto a retryable rate-limit error and keeps Retry-After', async () => {
    const transport = fakeFetch([
      new Response('{"error":{"message":"slow down"}}', {
        status: 429,
        headers: { 'retry-after': '45' },
      }),
    ])
    const provider = new OpenAIProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      fetchImpl: transport,
    })

    await assert.rejects(
      () => collect(provider, base),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.errorClass, 'rate_limit')
        assert.equal(error.retryable, true)
        assert.equal(error.retryAfterMs, 45_000)
        assert.match(error.message, /429/)
        return true
      },
    )
  })

  it('reports malformed chunks instead of dropping them', async () => {
    const transport = fakeFetch([streamResponse('data: {nope\n\n')])
    const provider = new OpenAIProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      fetchImpl: transport,
    })

    await assert.rejects(
      () => collect(provider, base),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.errorClass, 'unknown')
        assert.match(error.message, /Malformed stream chunk/)
        return true
      },
    )
  })

  it('handles a final line with no trailing newline', async () => {
    const transport = fakeFetch([
      streamResponse('data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}'),
    ])
    const provider = new OpenAIProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      fetchImpl: transport,
    })

    const events = await collect(provider, base)
    assert.deepEqual(events, [
      { type: 'text', text: 'tail' },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('lists models from the configured base URL', async () => {
    const transport = fakeFetch([
      new Response(JSON.stringify({ data: [{ id: 'llama3' }, { id: 'qwen3' }, {}] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ])
    const provider = new OpenAIProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'k',
      fetchImpl: transport,
    })

    const models = await provider.listModels()

    assert.equal(transport.calls[0]?.url, 'http://127.0.0.1:1234/v1/models')
    assert.equal(
      (transport.calls[0]?.init.headers as Record<string, string>)['authorization'],
      'Bearer k',
    )
    assert.deepEqual(
      models.map((model) => model.id),
      ['llama3', 'qwen3'],
    )
    assert.equal(models[0]?.contextWindow, 8192)
  })
})
