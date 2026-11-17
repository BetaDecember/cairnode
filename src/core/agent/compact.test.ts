import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUMMARY_PREFIX,
  activeTask,
  buildSummaryInput,
  compactConversation,
  endsMidWork,
  microcompact,
  summaryMessage,
} from './compact.ts'
import type { ChatMessage, ChatRequest, Provider, ProviderEvent } from '../provider/types.ts'

function tool(name: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: 'tool', toolName: name, ok: true, content, ...extra }
}

describe('microcompact', () => {
  it('stubs old, large tool output and keeps the newest results exact', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'fix it' },
      ...Array.from({ length: 6 }, (_, index) =>
        tool('Read', `file ${index}\n${'x'.repeat(2000)}`),
      ),
    ]

    const result = microcompact(messages, { keepRecent: 2, stubAt: 1200 })

    assert.equal(result.changed, true)
    assert.ok(result.savedChars > 0)
    assert.match(result.messages[1]?.content ?? '', /output trimmed/)
    assert.equal(result.messages[5]?.content, messages[5]?.content)
    assert.equal(result.messages[6]?.content, messages[6]?.content)
    assert.equal(result.messages[1]?.toolName, 'Read')
    assert.equal(result.messages[1]?.ok, true)
  })

  it('preserves metadata the transcript needs', () => {
    const messages: ChatMessage[] = [
      tool('Edit', 'y'.repeat(3000), {
        uiDiff: { path: 'src/a.ts', added: 2, removed: 1, lines: ['-a', '+b'] },
      }),
    ]

    const result = microcompact(messages, { keepRecent: 0 })
    assert.equal(result.messages[0]?.uiDiff?.path, 'src/a.ts')
    assert.equal(result.messages[0]?.ok, true)
  })

  it('is a no-op when everything is already short', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'fix it' },
      tool('Read', 'short'),
    ]
    const result = microcompact(messages)
    assert.equal(result.changed, false)
    assert.deepEqual(result.messages, messages)
  })

  it('leaves a single large result alone when it is the newest', () => {
    const messages: ChatMessage[] = [tool('Read', 'z'.repeat(5000))]
    const result = microcompact(messages, { keepRecent: 1 })
    assert.equal(result.changed, false)
  })
})

describe('activeTask', () => {
  it('skips a compaction summary', () => {
    const conversation: ChatMessage[] = [
      { role: 'user', content: 'Original task' },
      summaryMessage('we read two files'),
      { role: 'user', content: 'Now add the test' },
    ]
    assert.equal(activeTask(conversation), 'Now add the test')
  })

  it('returns empty when there is no real user message', () => {
    assert.equal(activeTask([summaryMessage('only a summary')]), '')
  })
})

describe('endsMidWork', () => {
  it('is true while a user turn or tool result is unanswered', () => {
    assert.equal(endsMidWork([{ role: 'user', content: 'fix it' }]), true)
    assert.equal(
      endsMidWork([
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', input: {} }] },
        { role: 'tool', toolName: 'Read', content: 'ok', ok: true },
      ]),
      true,
    )
  })

  it('is false after a final assistant reply', () => {
    assert.equal(
      endsMidWork([
        { role: 'user', content: 'fix it' },
        { role: 'assistant', content: 'Done.' },
      ]),
      false,
    )
    assert.equal(endsMidWork([]), false)
  })
})

describe('buildSummaryInput', () => {
  it('keeps the newest window and re-adds the original task', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Add multiply to math.js' },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'assistant' as const,
        content: `step ${index} ${'a'.repeat(300)}`,
      })),
    ]

    const input = buildSummaryInput(messages, 1000)
    assert.ok(input.length < 6000)
    assert.match(input, /ORIGINAL TASK/)
    assert.match(input, /Add multiply to math\.js/)
    assert.match(input, /step 29/)
    assert.doesNotMatch(input, /step 0 /)
  })

  it('clips the newest message when it alone exceeds the budget', () => {
    const input = buildSummaryInput(
      [{ role: 'user', content: 'q'.repeat(50_000) }],
      1000,
    )
    // The floor is 4000 chars, plus the ellipsis clip() appends.
    assert.ok(input.length <= 4001)
    assert.ok(input.endsWith('…'))
  })
})

describe('compactConversation', () => {
  const tools = [
    {
      name: 'Read',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
    },
  ]

  function fakeProvider(onChat?: (request: ChatRequest) => void): Provider {
    return {
      id: 'fake',
      listModels: async () => [],
      async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
        onChat?.(request)
        yield { type: 'text', text: '  The agent added multiply and ran the tests.  ' }
        yield { type: 'done', reason: 'stop' }
      },
    }
  }

  it('replaces history with a summary and the active task', async () => {
    const conversation: ChatMessage[] = [
      { role: 'user', content: 'Add multiply to math.js' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'src/math.js' } }],
      },
      { role: 'tool', toolName: 'Read', content: 'export function add…', ok: true },
    ]

    const captured: { request: ChatRequest | null } = { request: null }
    const result = await compactConversation(conversation, {
      provider: fakeProvider((request) => {
        captured.request = request
      }),
      model: 'qwen3.5:4b',
      numCtx: 8192,
      tools,
    })

    assert.equal(result.summary, 'The agent added multiply and ran the tests.')
    assert.equal(result.task, 'Add multiply to math.js')
    assert.equal(result.dropped, 3)
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[0]?.synthetic, 'summary')
    assert.match(result.messages[0]?.content ?? '', /^Summary of earlier work/)
    assert.equal(result.messages[1]?.content, 'Add multiply to math.js')

    // The instruction is appended to the live conversation so the cached prefix
    // can be reused, and tools stay in the request for the same reason.
    assert.equal(captured.request?.messages.at(-1)?.role, 'user')
    assert.match(captured.request?.messages.at(-1)?.content ?? '', /handoff summary/)
    assert.equal(captured.request?.tools.length, 1)
    assert.equal(captured.request?.think, false)
  })

  it('does not repeat a task that already has a final reply', async () => {
    const conversation: ChatMessage[] = [
      { role: 'user', content: 'Add multiply to math.js' },
      { role: 'assistant', content: 'Done. Both tests pass.' },
    ]

    const result = await compactConversation(conversation, {
      provider: fakeProvider(),
      model: 'qwen3.5:4b',
      numCtx: 8192,
      tools,
    })

    assert.equal(result.task, '')
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0]?.synthetic, 'summary')
  })

  it('falls back to a bounded transcript when the window is nearly full', async () => {
    const conversation: ChatMessage[] = [
      { role: 'user', content: 'task' },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: 'assistant' as const,
        content: `step ${index} ${'b'.repeat(2000)}`,
      })),
    ]

    const captured: { request: ChatRequest | null } = { request: null }
    await compactConversation(conversation, {
      provider: fakeProvider((request) => {
        captured.request = request
      }),
      model: 'qwen3.5:4b',
      numCtx: 2048,
      tools,
    })

    assert.equal(captured.request?.messages.length, 1)
    assert.match(captured.request?.messages[0]?.content ?? '', /SESSION TRANSCRIPT/)
    assert.equal(captured.request?.tools.length, 0)
  })

  it('rejects an empty summary instead of erasing history', async () => {
    const provider: Provider = {
      id: 'fake',
      listModels: async () => [],
      async *chat(): AsyncGenerator<ProviderEvent> {
        yield { type: 'done', reason: 'stop' }
      },
    }

    await assert.rejects(
      compactConversation([{ role: 'user', content: 'task' }], {
        provider,
        model: 'qwen3.5:4b',
        numCtx: 8192,
      }),
      /empty summary/,
    )
  })

  it('keeps the summary prefix stable for restored sessions', () => {
    assert.equal(summaryMessage('x').content, `${SUMMARY_PREFIX}\n\nx`)
  })
})
