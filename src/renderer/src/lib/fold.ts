import type { AgentEvent, CompactionRecord, ErrorClass, TodoItem, Usage } from '@core/types'
import type { ChatMessage } from '@core/provider/types'
import type { Block, TranscriptItem } from './transcript'

/**
 * Folds the agent's event stream into transcript items.
 *
 * Pure and synchronous: the store applies this to whatever is on screen, and
 * the same code path builds the transcript from a restored session. Keeping it
 * out of React means a long stream does not re-run any component logic per
 * token — only the final items are rendered.
 */

export interface Fold {
  items: TranscriptItem[]
  usage: Usage | null
  /** Wall-clock start of each tool call, for the elapsed label. */
  toolStarts: Record<string, number>
  /** Wall-clock start of each assistant item's thinking block. */
  thinkingStarts: Record<string, number>
}

export function emptyFold(): Fold {
  return { items: [], usage: null, toolStarts: {}, thinkingStarts: {} }
}

let counter = 0
export function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

/** Reset the id counter when loading a session so ids stay short and stable. */
export function resetIds(): void {
  counter = 0
}

export function summarizeInput(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  if (name === 'Bash') return `$ ${String(record['command'] ?? '').slice(0, 160)}`
  for (const key of ['path', 'pattern', 'glob']) {
    const value = record[key]
    if (typeof value === 'string') return value.slice(0, 160)
  }
  if (name === 'TodoWrite' && Array.isArray(record['items'])) {
    return `${record['items'].length} items`
  }
  return ''
}

/** Append a user message and open a fresh assistant turn. */
export function beginTurn(fold: Fold, text: string): Fold {
  return {
    ...fold,
    items: [
      ...fold.items,
      { kind: 'user', id: nextId('u'), text },
      { kind: 'assistant', id: nextId('a'), blocks: [] },
    ],
    usage: null,
  }
}

function lastAssistant(items: TranscriptItem[]): Extract<TranscriptItem, { kind: 'assistant' }> | null {
  const last = items.at(-1)
  return last?.kind === 'assistant' ? last : null
}

function editBlocks(fold: Fold, update: (blocks: Block[]) => Block[]): Fold {
  const items = fold.items.slice()
  const assistant = lastAssistant(items)
  if (!assistant) return fold
  items[items.length - 1] = { ...assistant, blocks: update(assistant.blocks) }
  return { ...fold, items }
}

/** Stop the trailing text/thinking block from streaming and stamp its duration. */
function seal(fold: Fold): Fold {
  const assistant = lastAssistant(fold.items)
  if (!assistant) return fold

  const started = fold.thinkingStarts[assistant.id]
  const seconds = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : undefined

  let changed = false
  const blocks = assistant.blocks.map((block): Block => {
    if (block.type === 'text' && block.streaming) {
      changed = true
      return { ...block, streaming: false }
    }
    if (block.type === 'thinking' && block.streaming) {
      changed = true
      return { ...block, streaming: false, seconds: block.seconds ?? seconds ?? 1 }
    }
    return block
  })

  if (!changed) return fold

  const items = fold.items.slice()
  items[items.length - 1] = { ...assistant, blocks }
  return { ...fold, items }
}

function appendThinking(fold: Fold, text: string): Fold {
  const assistant = lastAssistant(fold.items)
  if (!assistant) return fold

  const next = editBlocks(fold, (blocks) => {
    const last = blocks.at(-1)
    if (last?.type === 'thinking' && last.streaming) {
      return [...blocks.slice(0, -1), { ...last, text: last.text + text }]
    }
    return [...blocks, { type: 'thinking', text, streaming: true }]
  })

  if (next === fold) return fold
  if (fold.thinkingStarts[assistant.id]) return next
  return {
    ...next,
    thinkingStarts: { ...next.thinkingStarts, [assistant.id]: Date.now() },
  }
}

function appendText(fold: Fold, text: string): Fold {
  return editBlocks(fold, (blocks) => {
    const last = blocks.at(-1)
    if (last?.type === 'text' && last.streaming) {
      return [...blocks.slice(0, -1), { ...last, text: last.text + text }]
    }
    return [...blocks, { type: 'text', text, streaming: true }]
  })
}

function findTool(blocks: Block[], id: string): number {
  return blocks.findIndex((block) => block.type === 'tool' && block.id === id)
}

export function reduce(fold: Fold, event: AgentEvent): Fold {
  switch (event.type) {
    case 'session_state':
      return fold

    case 'thinking_delta':
      return appendThinking(fold, event.text)

    case 'text_delta':
      return appendText(fold, event.text)

    case 'tool_use': {
      const sealed = seal(fold)
      const withTool = editBlocks(sealed, (blocks) => [
        ...blocks,
        {
          type: 'tool',
          id: event.id,
          name: event.name,
          summary: event.summary,
          status: 'running',
        },
      ])
      return {
        ...withTool,
        toolStarts: { ...withTool.toolStarts, [event.id]: Date.now() },
      }
    }

    case 'tool_progress': {
      return editBlocks(fold, (blocks) =>
        blocks.map((block) => {
          if (block.type !== 'tool' || block.id !== event.id) return block
          const output = `${block.output ?? ''}${event.chunk}`
          return { ...block, output: output.length > 20_000 ? output.slice(-20_000) : output }
        }),
      )
    }

    case 'tool_result': {
      const text = event.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      const started = fold.toolStarts[event.id]

      return editBlocks(fold, (blocks) =>
        blocks.map((block) =>
          block.type === 'tool' && block.id === event.id
            ? {
                ...block,
                status: event.ok ? 'ok' : 'error',
                output: block.output ? `${block.output}\n${text}` : text,
                elapsedMs: started ? Date.now() - started : undefined,
              }
            : block,
        ),
      )
    }

    case 'tool_diff': {
      return editBlocks(fold, (blocks) => {
        const index = findTool(blocks, event.id)
        const diff: Block = {
          type: 'diff',
          id: `${event.id}:diff`,
          path: event.path,
          added: event.added,
          removed: event.removed,
          lines: event.lines,
        }
        if (index === -1) return [...blocks, diff]
        return [...blocks.slice(0, index + 1), diff, ...blocks.slice(index + 1)]
      })
    }

    case 'permission_request': {
      const sealed = seal(fold)
      return editBlocks(sealed, (blocks) => [
        ...blocks,
        {
          type: 'permission',
          id: event.id,
          tool: event.tool,
          command: event.summary,
          risk: event.risk,
        },
      ])
    }

    case 'todo_update': {
      const items: TodoItem[] = event.items
      return editBlocks(fold, (blocks) => {
        // Keep one plan block per turn: later TodoWrite calls update it in place
        // rather than stacking a new copy after every step.
        const index = blocks.findLastIndex((block) => block.type === 'todos')
        const existing = index === -1 ? null : blocks[index]
        const block: Block = {
          type: 'todos',
          id: existing?.type === 'todos' ? existing.id : nextId('todo'),
          items: items.map((item) => ({ text: item.text, status: item.status })),
        }
        if (index === -1) return [...blocks, block]
        return blocks.map((candidate, at) => (at === index ? block : candidate))
      })
    }

    case 'usage':
      return { ...fold, usage: event.usage }

    case 'compaction': {
      const sealed = seal(fold)
      const items = sealed.items.slice()
      items.push({
        kind: 'divider',
        id: nextId('c'),
        label: `Context compacted — ${event.dropped} earlier messages summarized`,
        detail: event.summary,
      })
      // The run continues in a fresh turn after the boundary.
      items.push({ kind: 'assistant', id: nextId('a'), blocks: [] })
      return { ...sealed, items, usage: null }
    }

    case 'error': {
      const sealed = seal(fold)
      return editBlocks(sealed, (blocks) => [
        ...blocks,
        {
          type: 'error',
          id: nextId('e'),
          title: errorTitle(event.errorClass),
          detail: event.detail,
          retryable: event.retryable,
        },
      ])
    }

    case 'done':
      return seal(fold)
  }
}

/** Mark a permission card as answered so its buttons stop being live. */
export function resolvePermission(
  fold: Fold,
  requestId: string,
  resolved: 'allowed' | 'denied',
): Fold {
  return editBlocks(fold, (blocks) =>
    blocks.map((block) =>
      block.type === 'permission' && block.id === requestId ? { ...block, resolved } : block,
    ),
  )
}

function errorTitle(kind: ErrorClass): string {
  switch (kind) {
    case 'auth':
      return 'Authentication failed'
    case 'rate_limit':
      return 'Rate limited'
    case 'overloaded':
      return 'Model server is busy'
    case 'context_overflow':
      return 'Context full'
    case 'tool_unsupported':
      return 'Tool not available'
    case 'network':
      return 'Cannot reach the model'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Something went wrong'
  }
}

/* --------------------------------------------------------------- restore */

/**
 * Rebuild the transcript from a stored conversation.
 *
 * Tool status and diffs survive because the loop stores them on the message.
 * Thinking is stored without its duration, so restored blocks show "Thought"
 * rather than a misleading "0s".
 */
export function foldMessages(
  messages: ChatMessage[],
  compactions: CompactionRecord[] = [],
): Fold {
  resetIds()
  const items: TranscriptItem[] = []
  const boundaries = new Map<number, CompactionRecord[]>()
  for (const compaction of compactions) {
    const list = boundaries.get(compaction.index) ?? []
    list.push(compaction)
    boundaries.set(compaction.index, list)
  }

  let current: Extract<TranscriptItem, { kind: 'assistant' }> | null = null

  const insertBoundaries = (index: number): void => {
    for (const compaction of boundaries.get(index) ?? []) {
      items.push({
        kind: 'divider',
        id: nextId('c'),
        label: `Context compacted — ${compaction.dropped} earlier messages summarized`,
        detail: compaction.summary,
      })
      current = null
    }
  }

  for (const [position, message] of messages.entries()) {
    insertBoundaries(position)

    if (message.role === 'user') {
      items.push({ kind: 'user', id: nextId('u'), text: message.content })
      current = null
      continue
    }

    if (message.role === 'assistant') {
      const blocks: Block[] = []
      if (message.thinking) blocks.push({ type: 'thinking', text: message.thinking })
      if (message.content.trim()) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool',
          id: call.id,
          name: call.name,
          summary: summarizeInput(call.name, call.input),
          status: 'running',
        })
      }
      current = { kind: 'assistant', id: nextId('a'), blocks }
      items.push(current)
      continue
    }

    if (message.role === 'tool' && current) {
      const match = current.blocks.findIndex(
        (block) =>
          block.type === 'tool' && block.status === 'running' && block.name === message.toolName,
      )
      if (match === -1) continue

      const tool = current.blocks[match]
      if (tool?.type !== 'tool') continue

      current.blocks = current.blocks.map((block, at) =>
        at === match
          ? { ...tool, status: message.ok === false ? 'error' : 'ok', output: message.content }
          : block,
      )

      if (message.uiDiff) {
        current.blocks = [
          ...current.blocks.slice(0, match + 1),
          {
            type: 'diff',
            id: `${tool.id}:diff`,
            path: message.uiDiff.path,
            added: message.uiDiff.added,
            removed: message.uiDiff.removed,
            lines: message.uiDiff.lines,
          },
          ...current.blocks.slice(match + 1),
        ]
      }
    }
  }

  insertBoundaries(messages.length)

  return { items, usage: null, toolStarts: {}, thinkingStarts: {} }
}
