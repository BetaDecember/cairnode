import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAgent } from './loop.ts'
import { builtinTools } from '../tools/builtin.ts'
import type { ChatRequest, Provider, ProviderEvent } from '../provider/types.ts'
import type { AgentEvent } from '../types.ts'

/**
 * A provider that replays a fixed script per turn, so the loop can be tested
 * without a model, a server, or several minutes of generation.
 */
function scripted(scripts: ProviderEvent[][]): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    id: 'scripted',
    requests,
    async listModels() {
      return []
    },
    async *chat(request: ChatRequest) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      for (const event of scripts[requests.length - 1] ?? []) yield event
    },
  }
}

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recode-loop-'))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  return dir
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const base = {
  model: 'test-model',
  numCtx: 8192,
  think: false,
  mode: 'bypass' as const,
  conversation: [{ role: 'user' as const, content: 'Add multiply.' }],
  tools: builtinTools,
}

describe('runAgent', () => {
  it('runs a read, edit, and verification pass', async () => {
    const cwd = await fixture({
      'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
      'src/math.test.js': "import { add } from './math.js'\n",
    })

    const provider = scripted([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'Read',
          input: { path: 'src/math.js' },
        },
      ],
      [
        {
          type: 'tool_call',
          id: 'c2',
          name: 'Edit',
          input: {
            path: 'src/math.js',
            old_string: 'export function add(a, b) {',
            new_string: 'export function multiply(a, b) {\n  return a * b\n}\n\nexport function add(a, b) {',
          },
        },
      ],
      [{ type: 'text', text: 'Added multiply.' }],
    ])

    const events = await collect(runAgent({ ...base, cwd, provider }))

    const file = await fs.readFile(path.join(cwd, 'src/math.js'), 'utf8')
    assert.ok(file.includes('export function multiply'), 'the edit landed on disk')

    const types = events.map((event) => event.type)
    assert.ok(types.includes('tool_use'))
    assert.ok(types.includes('tool_result'))
    assert.ok(types.includes('tool_diff'), 'edits surface a diff event')
    assert.ok(types.includes('text_delta'))
    assert.ok(types.includes('done'))

    const done = events.at(-1)
    assert.equal(done?.type, 'done')
    if (done?.type === 'done') assert.equal(done.stopReason, 'end_turn')

    const diff = events.find((event) => event.type === 'tool_diff')
    if (diff?.type === 'tool_diff') {
      assert.equal(diff.path, 'src/math.js')
      assert.ok(diff.added > 0)
    }

    // The tool result must be fed back with its tool name, which is the format
    // Ollama uses to correlate a result with the call that produced it.
    const second = provider.requests[1]
    assert.ok(second, 'the loop asked for a second turn')
    const toolMessage = second.messages.find((message) => message.role === 'tool')
    assert.equal(toolMessage?.toolName, 'Read')
    assert.match(toolMessage?.content ?? '', /export function add/)

    // The system prompt is first and carries no per-turn variation, so the
    // cached prefix survives across turns.
    assert.equal(second.messages[0]?.role, 'system')
    assert.equal(second.messages[0]?.content, provider.requests[0]?.messages[0]?.content)
  })

  it('emits a permission request and honours a denial', async () => {
    const cwd = await fixture({ 'README.md': '# fixture\n' })

    const provider = scripted([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'Bash',
          input: { command: 'echo nope > marker.txt' },
        },
      ],
      [{ type: 'text', text: 'Understood.' }],
    ])

    const asked: string[] = []
    const events = await collect(
      runAgent({
        ...base,
        cwd,
        provider,
        mode: 'default',
        ask: async (request) => {
          asked.push(request.tool)
          return 'deny'
        },
      }),
    )

    assert.deepEqual(asked, ['Bash'])

    const request = events.find((event) => event.type === 'permission_request')
    assert.ok(request, 'the UI is told a permission decision is pending')
    if (request?.type === 'permission_request') {
      assert.equal(request.tool, 'Bash')
      assert.equal(request.risk, 'high')
      assert.match(request.summary, /echo nope/)
    }

    const states = events
      .filter((event) => event.type === 'session_state')
      .map((event) => (event.type === 'session_state' ? event.state : ''))
    assert.ok(states.includes('awaiting_permission'))

    const result = events.find((event) => event.type === 'tool_result')
    if (result?.type === 'tool_result') assert.equal(result.ok, false)

    await assert.rejects(fs.stat(path.join(cwd, 'marker.txt')), 'the denied command never ran')
  })

  it('does not prompt for low-risk tools', async () => {
    const cwd = await fixture({ 'a.txt': 'hello\n' })

    const provider = scripted([
      [{ type: 'tool_call', id: 'c1', name: 'Read', input: { path: 'a.txt' } }],
      [{ type: 'text', text: 'Read it.' }],
    ])

    let prompts = 0
    const events = await collect(
      runAgent({
        ...base,
        cwd,
        provider,
        mode: 'default',
        ask: async () => {
          prompts++
          return 'allow_once'
        },
      }),
    )

    assert.equal(prompts, 0)
    assert.equal(
      events.some((event) => event.type === 'permission_request'),
      false,
    )
  })

  it('reports an unknown tool and keeps the turn alive', async () => {
    const cwd = await fixture({})

    const provider = scripted([
      [{ type: 'tool_call', id: 'c1', name: 'Teleport', input: {} }],
      [{ type: 'text', text: 'Sorry.' }],
    ])

    const events = await collect(runAgent({ ...base, cwd, provider }))
    const error = events.find((event) => event.type === 'error')
    if (error?.type === 'error') assert.equal(error.errorClass, 'tool_unsupported')

    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === 'tool')
    assert.match(toolMessage?.content ?? '', /Unknown tool: Teleport/)
    assert.equal(events.at(-1)?.type, 'done')
  })

  it('does not end a turn on thinking alone', async () => {
    const cwd = await fixture({})

    const provider = scripted([
      [
        { type: 'thinking', text: 'Hmm.' },
        { type: 'done', reason: 'length' },
      ],
    ])

    const events = await collect(runAgent({ ...base, cwd, provider }))
    const error = events.find((event) => event.type === 'error')
    assert.ok(error, 'an empty reply is surfaced, not silently accepted')

    const done = events.at(-1)
    if (done?.type === 'done') assert.equal(done.stopReason, 'max_tokens')
  })

  it('streams progress while a command is still running', async () => {
    const cwd = await fixture({})

    const provider = scripted([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'Bash',
          input: { command: 'echo one; sleep 0.2; echo two' },
        },
      ],
      [{ type: 'text', text: 'Ran it.' }],
    ])

    const events = await collect(runAgent({ ...base, cwd, provider }))
    const progress = events.filter((event) => event.type === 'tool_progress')
    assert.ok(progress.length >= 1, 'output is yielded before the command exits')
  })
})
