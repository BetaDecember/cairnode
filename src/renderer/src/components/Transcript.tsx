import { useEffect, useRef, useState } from 'react'
import type { TranscriptItem } from '../lib/transcript'
import { shortPath } from '../lib/path'
import { useApp } from '../state/store'
import { BlockView } from './blocks'
import { ChevronDown, Folder, Sparkle } from './icons'

/** Distance from the bottom that still counts as "following the stream". */
const STICK_PX = 64

export function Transcript() {
  const items = useApp((state) => state.fold.items)
  const running = useApp((state) => state.running)
  const sessionState = useApp((state) => state.sessionState)
  const activeId = useApp((state) => state.activeId)

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const follow = () => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }

  // Opening a session starts at its latest turn, not its first.
  useEffect(() => {
    stick.current = true
    follow()
  }, [activeId])

  // Sending follows the new turn even if the reader had scrolled back.
  useEffect(() => {
    if (!running) return
    stick.current = true
    follow()
  }, [running])

  // Streaming appends, so follow it — unless the reader scrolled away. Reading
  // old output while a command runs should not yank them to the bottom.
  useEffect(() => {
    if (stick.current) follow()
  }, [items, sessionState])

  const onScroll = () => {
    const element = scroller.current
    if (!element) return
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
  }

  if (items.length === 0) return <EmptyState />

  return (
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-7">
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        {running && <Activity state={sessionState} />}
        <div className="h-1" />
      </div>
    </div>
  )
}

function Activity({ state }: { state: string }) {
  const label =
    state === 'thinking'
      ? 'Thinking'
      : state === 'awaiting_permission'
        ? 'Waiting for permission'
        : state === 'compacting'
          ? 'Compacting context'
          : 'Working'

  return (
    <div className="flex items-center gap-2 pl-0.5 text-[11.5px] text-ink-faint">
      <span className="size-1.5 animate-pulse rounded-full bg-clay" />
      {label}…
    </div>
  )
}

function Item({ item }: { item: TranscriptItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-panel rounded-br-[4px] bg-panel-2 px-3.5 py-2.5 text-[13.5px] leading-[1.6] whitespace-pre-wrap text-ink">
          {item.text}
        </div>
      </div>
    )
  }

  if (item.kind === 'divider') {
    return <DividerItem item={item} />
  }

  if (item.blocks.length === 0) return null

  return (
    <div className="flex flex-col gap-2.5">
      {item.blocks.map((block, index) => (
        // Blocks are append-only inside a turn, so the index is a stable identity.
        // Text and thinking blocks have no id of their own.
        <BlockView key={`${item.id}:${index}`} block={block} />
      ))}
    </div>
  )
}

function DividerItem({ item }: { item: Extract<TranscriptItem, { kind: 'divider' }> }) {
  const [open, setOpen] = useState(false)
  const interactive = Boolean(item.detail)

  return (
    <div className="py-1">
      <button
        type="button"
        disabled={!interactive}
        onClick={() => setOpen((value) => !value)}
        title={interactive ? 'Show the summary' : undefined}
        className="flex w-full items-center gap-3 disabled:cursor-default"
      >
        <span className="h-px flex-1 bg-line" />
        <span className="flex items-center gap-1 text-[10.5px] tracking-[0.02em] text-ink-faint transition-colors hover:text-ink-muted">
          {item.label}
          {interactive && (
            <ChevronDown
              size={11}
              className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
          )}
        </span>
        <span className="h-px flex-1 bg-line" />
      </button>

      {open && item.detail && (
        <div className="mx-auto mt-2 max-w-[85%] whitespace-pre-wrap rounded-control border border-line bg-panel-2/50 px-3 py-2 text-[11.5px] leading-[1.6] text-ink-muted">
          {item.detail}
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  const chooseFolder = useApp((state) => state.chooseFolder)
  const models = useApp((state) => state.models)
  const cwd = useApp((state) => state.cwd)
  const ready = models.length > 0

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="w-full max-w-[440px] pb-16 text-center">
        <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-[10px] bg-clay">
          <svg width="18" height="18" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2 7.4V2.6h3.1a2.1 2.1 0 0 1 0 4.2H2"
              stroke="#fff"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <h1 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
          A coding agent that runs on your machine
        </h1>
        <p className="mt-1.5 text-[13px] leading-[1.6] text-ink-muted">
          Describe a change and watch every step — reads, edits, commands. Nothing leaves the
          machine.
        </p>

        {cwd ? (
          <div className="mt-5 inline-flex max-w-full items-center gap-2 rounded-control border border-line bg-panel px-2.5 py-1.5 font-mono text-[11.5px] text-ink-muted">
            <Folder size={13} className="shrink-0 text-ink-faint" />
            <span className="truncate">{shortPath(cwd)}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void chooseFolder()}
            className="mt-5 inline-flex items-center gap-2 rounded-control bg-ink px-3 py-1.5 text-[12.5px] font-medium text-canvas transition-opacity hover:opacity-90"
          >
            <Folder size={14} />
            Choose a project folder
          </button>
        )}

        <div className="mt-3 flex items-center justify-center gap-1.5 text-[11.5px] text-ink-faint">
          <Sparkle size={12} />
          {ready ? 'Local model ready' : 'Start Ollama to load a model'}
        </div>
      </div>
    </div>
  )
}
