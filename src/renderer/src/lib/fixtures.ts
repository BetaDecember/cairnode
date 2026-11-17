import type { SessionSummary, TranscriptItem } from './transcript'

export const sessions: SessionSummary[] = [
  {
    id: 's1',
    title: 'Add /health endpoint',
    preview: 'Route + test, all green',
    group: 'Today',
    active: true,
  },
  {
    id: 's2',
    title: 'Refactor auth middleware',
    preview: 'Splitting token verification out',
    group: 'Today',
  },
  {
    id: 's3',
    title: 'Why does the build hang?',
    preview: 'Circular import in graph',
    group: 'Today',
  },
  {
    id: 's4',
    title: 'Migrate config to Zod',
    preview: 'Schema drafted, needs review',
    group: 'Yesterday',
  },
  {
    id: 's5',
    title: 'Parser fuzz failures',
    preview: 'Found 3 crash cases',
    group: 'Yesterday',
  },
  {
    id: 's6',
    title: 'Write the README',
    preview: 'Draft complete',
    group: 'Earlier',
  },
]

export const transcript: TranscriptItem[] = [
  {
    kind: 'user',
    id: 'u1',
    text: 'Add a /health endpoint to the API with a test. Keep it consistent with the existing routes.',
  },
  {
    kind: 'assistant',
    id: 'a1',
    blocks: [
      {
        type: 'thinking',
        seconds: 6,
        text: 'The routes live in src/api/routes. I should look at an existing route to copy its shape, then check how tests are structured before writing anything.',
      },
      {
        type: 'text',
        text: "I'll look at an existing route first so the new one matches.",
      },
      {
        type: 'tool',
        id: 't1',
        name: 'Read',
        summary: 'src/api/routes/users.ts',
        status: 'ok',
        elapsedMs: 40,
        output:
          "import { Router } from 'express'\nimport { db } from '../db'\n\nconst router = Router()\n\nrouter.get('/', async (_req, res) => {\n  res.json({ users: await db.user.findMany() })\n})\n\nexport default router",
      },
      {
        type: 'tool',
        id: 't2',
        name: 'Glob',
        summary: 'src/**/*.test.ts',
        status: 'ok',
        elapsedMs: 90,
        output: 'src/api/routes/users.test.ts\nsrc/api/routes/auth.test.ts\nsrc/lib/parser.test.ts',
      },
      {
        type: 'diff',
        id: 'd1',
        path: 'src/api/routes/health.ts',
        added: 9,
        removed: 0,
        lines: [
          "+import { Router } from 'express'",
          '+',
          '+const router = Router()',
          '+',
          "+router.get('/', (_req, res) => {",
          "+  res.json({ status: 'ok', uptime: process.uptime() })",
          '+})',
          '+',
          '+export default router',
        ],
      },
      {
        type: 'tool',
        id: 't3',
        name: 'Bash',
        summary: 'pnpm vitest run health',
        status: 'running',
        output: ' RUN  v3.2.4\n\n ✓ src/api/routes/health.test.ts (1 test) 12ms',
      },
    ],
  },
  {
    kind: 'divider',
    id: 'div1',
    label: 'Context compacted · earlier tool output dropped',
  },
  {
    kind: 'assistant',
    id: 'a2',
    blocks: [
      {
        type: 'todos',
        id: 'todo1',
        items: [
          { text: 'Read an existing route for conventions', status: 'done' },
          { text: 'Add src/api/routes/health.ts', status: 'done' },
          { text: 'Write health.test.ts', status: 'in_progress' },
          { text: 'Run the suite', status: 'pending' },
        ],
      },
      {
        type: 'permission',
        id: 'p1',
        tool: 'Bash',
        command: 'git add src/api/routes/health.ts src/api/routes/health.test.ts',
        risk: 'medium',
      },
    ],
  },
  {
    kind: 'user',
    id: 'u2',
    text: 'go ahead',
  },
  {
    kind: 'assistant',
    id: 'a3',
    blocks: [
      {
        type: 'text',
        text: 'Staged. The suite is green — one new test, no regressions.',
        streaming: true,
      },
      {
        type: 'error',
        id: 'e1',
        title: 'Context nearly full',
        detail: '12,180 of 13,312 tokens used (91%). Compacting before the next turn.',
        retryable: false,
      },
    ],
  },
]
