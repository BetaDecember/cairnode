import { useState } from 'react'
import type { Block } from '../lib/transcript'
import { cn } from '../lib/cn'
import { Alert, Check, ChevronDown, ChevronRight, File, Terminal } from './icons'

const mono = 'font-mono text-[12px] leading-[1.6]'

function Elapsed({ ms }: { ms?: number }) {
  if (ms == null) return null
  return <span className="text-ink-faint">{ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}</span>
}

/* ---------------------------------------------------------------- thinking */

function ThinkingBlock({ text, seconds }: { text: string; seconds: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-panel border border-line/80 bg-panel-2/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-ink-muted transition-colors hover:text-ink"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">Thought for {seconds}s</span>
      </button>
      {open && (
        <div className="border-t border-line/70 px-3 py-2.5 text-[13px] leading-[1.65] whitespace-pre-wrap text-ink-muted">
          {text}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------- tools */

function ToolCard({
  name,
  summary,
  status,
  output,
  elapsedMs,
}: {
  name: string
  summary: string
  status: 'running' | 'ok' | 'error'
  output?: string
  elapsedMs?: number
}) {
  const [open, setOpen] = useState(false)
  const tone =
    status === 'running' ? 'text-ink-faint' : status === 'ok' ? 'text-ok' : 'text-danger'

  return (
    <div className="overflow-hidden rounded-panel border border-line bg-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className={cn('shrink-0', tone)}>
          {status === 'running' ? (
            <span className="block size-2 animate-pulse rounded-full bg-clay" />
          ) : status === 'ok' ? (
            <Check size={14} />
          ) : (
            <Alert size={14} />
          )}
        </span>
        <Terminal size={14} className="shrink-0 text-ink-faint" />
        <span className="font-mono text-[12px] font-medium text-ink">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">
          {summary}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums">
          <Elapsed ms={elapsedMs} />
        </span>
        <span className="shrink-0 text-ink-faint">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && output && (
        <pre
          className={cn(
            mono,
            'max-h-64 overflow-auto border-t border-line bg-panel-2/50 px-3 py-2.5 text-ink-muted',
          )}
        >
          {output}
        </pre>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- diff */

function DiffCard({
  path,
  added,
  removed,
  lines,
}: {
  path: string
  added: number
  removed: number
  lines: string[]
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <File size={14} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{path}</span>
        <span className="shrink-0 font-mono text-[11px] text-ok">+{added}</span>
        <span className="shrink-0 font-mono text-[11px] text-danger">−{removed}</span>
        <span className="shrink-0 text-ink-faint">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && (
        <div className="border-t border-line">
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                mono,
                'flex gap-3 px-3',
                line.startsWith('+') && 'bg-ok/10 text-ok',
                line.startsWith('-') && 'bg-danger/10 text-danger',
                !line.startsWith('+') && !line.startsWith('-') && 'text-ink-muted',
              )}
            >
              <span className="w-4 shrink-0 select-none text-right text-ink-faint">{i + 1}</span>
              <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- permission */

function PermissionCard({
  command,
  risk,
}: {
  command: string
  risk: 'low' | 'medium' | 'high'
}) {
  return (
    <div className="rounded-panel border border-warn/35 bg-warn/6 p-3">
      <div className="mb-1 flex items-center gap-2">
        <Alert size={14} className="text-warn" />
        <span className="text-[12px] font-medium text-ink">Run this command?</span>
        <span className="rounded-full border border-warn/40 px-1.5 text-[10px] uppercase tracking-wide text-warn">
          {risk}
        </span>
      </div>
      <pre
        className={cn(
          mono,
          'my-2 overflow-x-auto rounded-control border border-line bg-panel px-2.5 py-2 text-ink',
        )}
      >
        {command}
      </pre>
      <div className="flex items-center gap-2">
        <button className="rounded-control bg-ink px-2.5 py-1 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90">
          Allow once
        </button>
        <button className="rounded-control border border-line bg-panel px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-panel-2">
          Allow for session
        </button>
        <button className="rounded-control px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:text-ink">
          Deny
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- error */

function ErrorCard({
  title,
  detail,
  retryable,
}: {
  title: string
  detail: string
  retryable: boolean
}) {
  return (
    <div className="rounded-panel border border-danger/30 bg-danger/6 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Alert size={14} className="text-danger" />
        <span className="text-[12px] font-medium text-ink">{title}</span>
        {retryable && (
          <button className="ml-auto text-[12px] font-medium text-danger hover:underline">
            Retry
          </button>
        )}
      </div>
      <p className="mt-1 pl-6 text-[12px] leading-relaxed text-ink-muted">{detail}</p>
    </div>
  )
}

/* ------------------------------------------------------------------- todos */

function TodoBlock({ items }: { items: Array<{ text: string; status: string }> }) {
  return (
    <div className="rounded-panel border border-line bg-panel px-3 py-2.5">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        Plan
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.text} className="flex items-start gap-2">
            <span
              className={cn(
                'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                item.status === 'done' && 'border-ok bg-ok text-panel',
                item.status === 'in_progress' && 'border-clay',
                item.status === 'pending' && 'border-line-strong',
              )}
            >
              {item.status === 'done' && <Check size={9} />}
              {item.status === 'in_progress' && <span className="size-1.5 rounded-full bg-clay" />}
            </span>
            <span
              className={cn(
                'text-[12.5px] leading-[1.5]',
                item.status === 'done' ? 'text-ink-faint line-through' : 'text-ink',
              )}
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------ router */

export function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'text':
      return (
        <p
          className={cn(
            'text-[14px] leading-[1.7] whitespace-pre-wrap text-ink',
            block.streaming && 'caret',
          )}
        >
          {block.text}
        </p>
      )
    case 'thinking':
      return <ThinkingBlock text={block.text} seconds={block.seconds} />
    case 'tool':
      return (
        <ToolCard
          name={block.name}
          summary={block.summary}
          status={block.status}
          output={block.output}
          elapsedMs={block.elapsedMs}
        />
      )
    case 'diff':
      return (
        <DiffCard
          path={block.path}
          added={block.added}
          removed={block.removed}
          lines={block.lines}
        />
      )
    case 'permission':
      return <PermissionCard command={block.command} risk={block.risk} />
    case 'error':
      return (
        <ErrorCard title={block.title} detail={block.detail} retryable={block.retryable} />
      )
    case 'todos':
      return <TodoBlock items={block.items} />
  }
}
