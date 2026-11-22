import { useState } from 'react'
import type { Block } from '../lib/transcript'
import { segments } from '@core/markdown'
import { cn } from '../lib/cn'
import { useApp } from '../state/store'
import { Alert, Check, ChevronDown, ChevronRight, File, Terminal } from './icons'

const mono = 'font-mono text-[12px] leading-[1.6]'

/* -------------------------------------------------------------------- text */

/** Inline code only. Bold and links would need a real parser; they can wait. */
function prose(text: string): React.ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((chunk, index) =>
    chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 2 ? (
      <code
        key={index}
        className="rounded-[4px] border border-line bg-panel-2 px-1 py-[1px] font-mono text-[12px] text-ink"
      >
        {chunk.slice(1, -1)}
      </code>
    ) : (
      <span key={index}>{chunk}</span>
    ),
  )
}

function RichText({ text, streaming }: { text: string; streaming?: boolean }) {
  const parts = segments(text)

  return (
    <div className="flex flex-col gap-2">
      {parts.map((segment, index) =>
        segment.type === 'code' ? (
          <pre
            key={index}
            className={cn(
              mono,
              'overflow-x-auto rounded-control border border-line bg-panel-2/60 px-3 py-2 text-ink',
            )}
          >
            {segment.text}
          </pre>
        ) : segment.text.trim() === '' ? null : (
          <p
            key={index}
            className={cn(
              'text-[14px] leading-[1.7] whitespace-pre-wrap text-ink',
              streaming && index === parts.length - 1 && 'caret',
            )}
          >
            {prose(segment.text)}
          </p>
        ),
      )}
    </div>
  )
}

function Elapsed({ ms }: { ms?: number }) {
  if (ms == null) return null
  return (
    <span className="text-ink-faint">
      {ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}
    </span>
  )
}

/* ---------------------------------------------------------------- thinking */

function ThinkingBlock({ text, seconds }: { text: string; seconds?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-panel border border-line/80 bg-panel-2/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-ink-muted transition-colors hover:text-ink"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">
          {seconds ? `Thought for ${seconds}s` : 'Thought'}
        </span>
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
  // While a command is producing output, show it. The user can collapse it or
  // pin it open; their choice wins once made.
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? (status === 'running' && Boolean(output))

  const tone =
    status === 'running' ? 'text-ink-faint' : status === 'ok' ? 'text-ok' : 'text-danger'

  return (
    <div className="overflow-hidden rounded-panel border border-line bg-panel">
      <button
        type="button"
        onClick={() => setManual(!open)}
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
        onClick={() => setOpen((value) => !value)}
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
          {lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                mono,
                'flex gap-3 px-3',
                line.startsWith('+') && 'bg-ok/10 text-ok',
                line.startsWith('-') && 'bg-danger/10 text-danger',
                !line.startsWith('+') && !line.startsWith('-') && 'text-ink-muted',
              )}
            >
              <span className="w-4 shrink-0 select-none text-right text-ink-faint">
                {index + 1}
              </span>
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
  id,
  tool,
  command,
  detail,
  risk,
  resolved,
}: {
  id: string
  tool: string
  command: string
  detail?: string
  risk: 'low' | 'medium' | 'high'
  resolved?: 'allowed' | 'denied'
}) {
  const respond = useApp((state) => state.respond)

  const question =
    tool === 'Bash'
      ? 'Run this command?'
      : tool === 'Write' || tool === 'Edit'
        ? 'Apply this edit?'
        : `Allow ${tool}?`

  return (
    <div className="rounded-panel border border-warn/35 bg-warn/6 p-3">
      <div className="mb-1 flex items-center gap-2">
        <Alert size={14} className="text-warn" />
        <span className="text-[12px] font-medium text-ink">
          {resolved ? 'Permission answered' : question}
        </span>
        <span className="rounded-full border border-warn/40 px-1.5 text-[10px] uppercase tracking-wide text-warn">
          {risk}
        </span>
        {resolved && (
          <span
            className={cn(
              'ml-auto text-[11px] font-medium',
              resolved === 'allowed' ? 'text-ok' : 'text-danger',
            )}
          >
            {resolved === 'allowed' ? 'Allowed' : 'Denied'}
          </span>
        )}
      </div>
      <pre
        className={cn(
          mono,
          'my-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-panel px-2.5 py-2 text-ink',
        )}
      >
        {detail ?? command}
      </pre>
      {tool === 'Bash' && (
        <p className="mb-2 text-[11.5px] leading-relaxed text-ink-muted">
          Bash runs with your user&rsquo;s permissions. It can read or write anything you
          can, including outside this project, and it can reach the network.
        </p>
      )}
      {!resolved && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void respond(id, 'allow_once')}
            className="rounded-control bg-ink px-2.5 py-1 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={() => void respond(id, 'allow_session')}
            className="rounded-control border border-line bg-panel px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-panel-2"
          >
            Allow all {tool} for this session
          </button>
          <button
            type="button"
            onClick={() => void respond(id, 'deny')}
            className="rounded-control px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:text-ink"
          >
            Deny
          </button>
        </div>
      )}
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
          <span className="ml-auto text-[12px] font-medium text-danger">Send again to retry</span>
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
      return <RichText text={block.text} streaming={block.streaming} />
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
      return (
        <PermissionCard
          id={block.id}
          tool={block.tool}
          command={block.command}
          detail={block.detail}
          risk={block.risk}
          resolved={block.resolved}
        />
      )
    case 'error':
      return (
        <ErrorCard title={block.title} detail={block.detail} retryable={block.retryable} />
      )
    case 'todos':
      return <TodoBlock items={block.items} />
  }
}
