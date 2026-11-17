import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { ArrowUp, Stop } from './icons'

interface Props {
  onSend?: (text: string) => void
  running?: boolean
}

export function Composer({ onSend, running = false }: Props) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-grow up to ~9 lines, then scroll.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const submit = () => {
    const text = value.trim()
    if (!text || running) return
    onSend?.(text)
    setValue('')
  }

  return (
    <div className="shrink-0 px-6 pb-3">
      <div className="mx-auto w-full max-w-[760px]">
        <div
          className={cn(
            'rounded-composer border border-line bg-panel',
            'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_30px_-12px_rgba(0,0,0,0.14)]',
            'focus-within:border-line-strong',
          )}
        >
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape' && running) {
                e.preventDefault()
              }
            }}
            placeholder="Ask for a change, or describe a bug…"
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-2 text-[13.5px] leading-[1.55] text-ink outline-none placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <Chip>qwen3.5:4b</Chip>
            <Chip>default</Chip>
            <Chip muted>4 files</Chip>
            <div className="ml-auto flex items-center gap-1.5">
              <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-faint">
                ⏎
              </kbd>
              <button
                type="button"
                onClick={submit}
                aria-label={running ? 'Stop' : 'Send'}
                className={cn(
                  'flex size-7 items-center justify-center rounded-full transition-colors',
                  running
                    ? 'bg-ink text-canvas hover:opacity-90'
                    : value.trim()
                      ? 'bg-clay text-white hover:opacity-90'
                      : 'bg-panel-2 text-ink-faint',
                )}
              >
                {running ? <Stop size={14} /> : <ArrowUp size={14} />}
              </button>
            </div>
          </div>
        </div>
        <UsageLine />
      </div>
    </div>
  )
}

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-full border px-2 py-[2px] text-[11px] transition-colors',
        muted
          ? 'border-transparent text-ink-faint hover:text-ink-muted'
          : 'border-line bg-canvas text-ink-muted hover:border-line-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

function UsageLine() {
  const used = 12180
  const total = 13312
  const pct = Math.round((used / total) * 100)
  return (
    <div className="mt-1.5 flex items-center gap-2 px-1 text-[10.5px] text-ink-faint">
      <div className="h-[3px] w-24 overflow-hidden rounded-full bg-line">
        <div
          className={cn('h-full rounded-full', pct > 85 ? 'bg-warn' : 'bg-clay')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums">
        {used.toLocaleString()} / {total.toLocaleString()} tokens
      </span>
      <span>·</span>
      <span>estimated</span>
      <span className="ml-auto">$0.00 · local</span>
    </div>
  )
}
