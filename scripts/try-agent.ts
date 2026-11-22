#!/usr/bin/env node
/**
 * Headless agent harness.
 *
 * Creates a throwaway project, runs the real agent loop against a real model,
 * prints the event stream, and then verifies the result *independently* — it
 * runs the fixture's tests itself rather than trusting the transcript.
 *
 *   node scripts/try-agent.ts
 *   node scripts/try-agent.ts --model llama3.3:8b --no-think
 *   node scripts/try-agent.ts --dry          # scripted provider, no model
 *   node scripts/try-agent.ts --keep         # leave the fixture on disk
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { runAgent } from '../src/core/agent/loop.ts'
import { builtinTools } from '../src/core/tools/builtin.ts'
import { OllamaProvider } from '../src/core/provider/ollama.ts'
import type { Provider } from '../src/core/provider/types.ts'

const run = promisify(execFile)

const args = process.argv.slice(2)
const has = (name: string) => args.includes(`--${name}`)
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

const dry = has('dry')
const keep = has('keep')
const model = option('model', 'qwen3.5:4b')
const numCtx = Number(option('ctx', '8192'))
const think = !has('no-think')
const task = option(
  'task',
  'Add a multiply(a, b) function to src/math.js, next to add. Add a test for it in src/math.test.js. Run `node --test` and make sure it passes.',
)

const FIXTURE: Record<string, string> = {
  'package.json': `${JSON.stringify(
    { name: 'fixture', private: true, type: 'module' },
    null,
    2,
  )}\n`,
  'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
  'src/math.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add } from './math.js'

test('add', () => {
  assert.equal(add(2, 3), 5)
})
`,
}

/* ------------------------------------------------------------------ output */

const startedAt = Date.now()
const stamp = () => {
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  return `[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}]`
}

let inText = false

function line(message: string): void {
  if (inText) {
    process.stdout.write('\n')
    inText = false
  }
  process.stdout.write(`${stamp()} ${message}\n`)
}

function textChunk(chunk: string): void {
  if (!inText) {
    process.stdout.write(`${stamp()} │ `)
    inText = true
  }
  process.stdout.write(chunk)
}

/* -------------------------------------------------------------------- dry */

function dryProvider(): Provider {
  let turn = 0
  return {
    id: 'dry',
    async listModels() {
      return []
    },
    async *chat() {
      turn++
      if (turn === 1) {
        yield { type: 'thinking', text: 'I should look at the file before changing it.' }
        yield { type: 'text', text: 'Reading the existing module first.' }
        yield { type: 'tool_call', id: 'c1', name: 'Read', input: { path: 'src/math.js' } }
      } else {
        yield { type: 'text', text: 'Dry run complete.' }
        yield { type: 'usage', promptTokens: 812, outputTokens: 18, cachedTokens: 640 }
        yield { type: 'done', reason: 'stop' }
      }
    },
  }
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<number> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cairnode-agent-'))
  for (const [name, content] of Object.entries(FIXTURE)) {
    const target = path.join(cwd, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }

  line(`fixture  ${cwd}`)
  line(`model    ${dry ? 'dry (scripted)' : model}${dry ? '' : `  ctx=${numCtx}  think=${think}`}`)
  line(`task     ${task}`)
  line('─'.repeat(72))

  const controller = new AbortController()
  process.on('SIGINT', () => {
    line('interrupted')
    controller.abort()
  })

  let thinkingChars = 0
  let toolCalls = 0
  let failures = 0
  let lastStop = '?'

  const agent = runAgent({
    model,
    cwd,
    numCtx,
    think,
    mode: 'bypass',
    conversation: [{ role: 'user', content: task }],
    tools: builtinTools,
    provider: dry ? dryProvider() : new OllamaProvider(),
    signal: controller.signal,
  })

  for await (const event of agent) {
    switch (event.type) {
      case 'session_state':
        break

      case 'thinking_delta':
        thinkingChars += event.text.length
        if (thinkingChars === event.text.length) line('· thinking…')
        break

      case 'text_delta':
        if (thinkingChars > 0) {
          line(`· thought ${thinkingChars} chars`)
          thinkingChars = 0
        }
        textChunk(event.text)
        break

      case 'tool_use':
        if (thinkingChars > 0) {
          line(`· thought ${thinkingChars} chars`)
          thinkingChars = 0
        }
        toolCalls++
        line(`→ ${event.name} ${summarizeInput(event.input)}`)
        break

      case 'tool_progress': {
        const chunk = event.chunk.trim()
        if (chunk) line(`  │ ${chunk.split('\n').slice(-1)[0]?.slice(0, 200) ?? ''}`)
        break
      }

      case 'tool_result': {
        const body = event.content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
        if (!event.ok) failures++
        line(`← ${event.ok ? 'ok' : 'FAILED'} (${body.length} chars)`)
        break
      }

      case 'tool_diff':
        line(`± ${event.path} +${event.added} −${event.removed}`)
        break

      case 'permission_request':
        line(`! permission needed: ${event.tool} — ${event.summary}`)
        break

      case 'todo_update':
        line(`☐ plan: ${event.items.length} items`)
        break

      case 'usage':
        line(
          `   tokens prompt=${event.usage.promptTokens} cached=${event.usage.cachedTokens} out=${event.usage.outputTokens} ctx=${Math.round(event.usage.contextPct * 100)}%`,
        )
        break

      case 'error':
        line(`✖ [${event.errorClass}] ${event.detail}`)
        break

      case 'done':
        if (inText) process.stdout.write('\n')
        inText = false
        lastStop = event.stopReason
        line(`done (${event.stopReason})`)
        break
    }
  }

  line('─'.repeat(72))

  let code = 0

  if (dry) {
    line('verification skipped in dry mode')
  } else {
    const source = await fs.readFile(path.join(cwd, 'src/math.js'), 'utf8')
    const hasMultiply = /\bmultiply\b/.test(source)
    line(`multiply defined: ${hasMultiply ? 'yes' : 'NO'}`)
    if (!hasMultiply) code = 1

    try {
      const { stdout } = await run('node', ['--test'], { cwd })
      const summary = stdout.split('\n').find((row) => row.startsWith('ℹ pass')) ?? ''
      line(`node --test: ${summary.trim() || 'passed'}`)
      line('tests: PASS')
    } catch (error) {
      const stdout = String((error as { stdout?: string }).stdout ?? '')
      line('tests: FAIL')
      line(stdout.split('\n').slice(-15).join('\n'))
      code = 1
    }
  }

  line(
    `wall=${((Date.now() - startedAt) / 1000).toFixed(1)}s tools=${toolCalls} tool_failures=${failures} stop=${lastStop}`,
  )

  if (keep) line(`fixture kept at ${cwd}`)
  else await fs.rm(cwd, { recursive: true, force: true })

  return code
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['path', 'pattern', 'command']) {
    const value = record[key]
    if (typeof value === 'string') return value.slice(0, 120)
  }
  return ''
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  },
)
