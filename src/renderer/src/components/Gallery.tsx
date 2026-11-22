import type { Block } from '../lib/transcript'
import { BlockView } from './blocks'

/**
 * The component gallery is the visual test surface. Every block renders here in
 * isolation, so styling changes can be reviewed without starting a model turn.
 */

const cases: Array<{ label: string; note?: string; block: Block }> = [
  {
    label: 'Text',
    block: {
      type: 'text',
      text: 'The suite is green — one new test, no regressions.',
    },
  },
  {
    label: 'Text / streaming',
    block: { type: 'text', text: 'Reading the router to match conventions', streaming: true },
  },
  {
    label: 'Thinking / collapsed',
    block: {
      type: 'thinking',
      seconds: 6,
      text: 'Check the existing routes before writing a new one.',
    },
  },
  {
    label: 'Tool / running',
    block: {
      type: 'tool',
      id: 'g1',
      name: 'Bash',
      summary: 'pnpm vitest run health',
      status: 'running',
      output: ' RUN  v3.2.4\n\n ✓ src/api/routes/health.test.ts (1 test) 12ms',
    },
  },
  {
    label: 'Tool / ok',
    block: {
      type: 'tool',
      id: 'g2',
      name: 'Read',
      summary: 'src/api/routes/users.ts',
      status: 'ok',
      elapsedMs: 40,
      output: "import { Router } from 'express'",
    },
  },
  {
    label: 'Tool / error',
    block: {
      type: 'tool',
      id: 'g3',
      name: 'Bash',
      summary: 'pnpm test',
      status: 'error',
      elapsedMs: 2400,
      output: 'Error: command timed out after 120s',
    },
  },
  {
    label: 'Diff',
    block: {
      type: 'diff',
      id: 'g4',
      path: 'src/api/routes/health.ts',
      added: 9,
      removed: 1,
      lines: [
        "import { Router } from 'express'",
        '-const router = Router({ strict: true })',
        '+const router = Router()',
        '',
        "router.get('/', (_req, res) => {",
        "  res.json({ status: 'ok' })",
        '})',
      ],
    },
  },
  {
    label: 'Permission',
    block: {
      type: 'permission',
      id: 'g5',
      tool: 'Bash',
      command: '$ npm test > ../test.log 2>&1',
      detail: 'npm test -- --grep "health" > ../test.log 2>&1',
      risk: 'high',
    },
  },
  {
    label: 'Error',
    block: {
      type: 'error',
      id: 'g6',
      title: 'Context nearly full',
      detail: '12,180 of 13,312 tokens used (91%). Compacting before the next turn.',
      retryable: false,
    },
  },
  {
    label: 'Error / retryable',
    block: {
      type: 'error',
      id: 'g7',
      title: 'Provider unreachable',
      detail: 'Connection refused at 127.0.0.1:11434. Is the Ollama server running?',
      retryable: true,
    },
  },
  {
    label: 'Todos',
    block: {
      type: 'todos',
      id: 'g8',
      items: [
        { text: 'Read an existing route for conventions', status: 'done' },
        { text: 'Add src/api/routes/health.ts', status: 'done' },
        { text: 'Write health.test.ts', status: 'in_progress' },
        { text: 'Run the suite', status: 'pending' },
      ],
    },
  },
]

export function Gallery() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-7">
        <h1 className="text-[15px] font-semibold text-ink">Component gallery</h1>
        <p className="mt-1 mb-6 text-[12.5px] text-ink-muted">
          Every transcript block, isolated. This is the surface visual regressions are
          caught on.
        </p>
        <div className="flex flex-col gap-7">
          {cases.map((c) => (
            <section key={c.label}>
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
                  {c.label}
                </h2>
                {c.note && <span className="text-[11px] text-ink-faint">{c.note}</span>}
              </div>
              <BlockView block={c.block} />
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
