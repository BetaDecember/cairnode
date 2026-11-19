import { useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorClass } from '@core/types'
import type { ProviderId } from '@core/settings'
import { cn } from '../lib/cn'
import { providerLabel } from '../lib/providers'
import { useApp } from '../state/store'
import { ArrowUp, Stop } from './icons'

const MODE_LABEL: Record<string, string> = {
  default: 'ask',
  acceptEdits: 'edits',
  plan: 'plan',
  bypass: 'bypass',
}

const COMMANDS = [
  { name: '/clear', description: 'Start a fresh session in this project' },
  { name: '/compact', description: 'Summarize earlier turns to free context' },
] as const

interface RetryState {
  errorClass: ErrorClass
  attempt: number
  maxAttempts: number
  waitMs: number
}

function retryLabel(errorClass: ErrorClass): string {
  if (errorClass === 'rate_limit') return 'Rate limited'
  if (errorClass === 'overloaded') return 'Provider busy'
  if (errorClass === 'network') return 'Connection lost'
  return 'Provider error'
}

/** Measured on the reference Intel Mac; see `docs/benchmark.md`. */
const COLD_PREFILL_TOK_PER_SEC = 31.1
const CACHED_PREFILL_TOK_PER_SEC = 2_000

function prefillSeconds(
  used: number,
  cachedShare: number,
): number {
  const cached = Math.round(used * cachedShare)
  return (used - cached) / COLD_PREFILL_TOK_PER_SEC + cached / CACHED_PREFILL_TOK_PER_SEC
}

function formatWait(seconds: number): string {
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `~${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest > 0 ? `~${minutes}m ${rest}s` : `~${minutes}m`
}

function isLocalEndpoint(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

const MAX_SUGGESTIONS = 8

/** The `@token` being typed at the caret, if any. */
function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  return { start: before.length - match[2]!.length - 1, query: match[2]! }
}

function countAts(value: string): number {
  let count = 0
  for (const character of value) if (character === '@') count += 1
  return count
}

function mentionTokens(value: string): string[] {
  const paths: string[] = []
  for (const match of value.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const path = match[1]
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

export function Composer() {
  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [filesFor, setFilesFor] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const running = useApp((state) => state.running)
  const activeId = useApp((state) => state.activeId)
  const send = useApp((state) => state.send)
  const abort = useApp((state) => state.abort)
  const models = useApp((state) => state.models)
  const provider = useApp((state) => state.provider)
  const model = useApp((state) => state.model)
  const setModel = useApp((state) => state.setModel)
  const mode = useApp((state) => state.mode)
  const cycleMode = useApp((state) => state.cycleMode)
  const usage = useApp((state) => state.fold.usage)
  const compacting = useApp((state) => state.compacting)
  const compact = useApp((state) => state.compact)
  const newSession = useApp((state) => state.newSession)
  const retry = useApp((state) => state.retry)
  const settings = useApp((state) => state.settings)
  const memory = useApp((state) => state.memory)
  const notify = useApp((state) => state.notify)

  // External endpoints do not run at the local benchmark's prefill speed.
  const showPrefill = provider === 'ollama' || isLocalEndpoint(settings?.openai.baseUrl)

  const gated = Boolean(memory && memory.files.length > 0 && memory.trust !== 'trusted')
  const slash = value.trimStart().startsWith('/') ? value.trim().toLowerCase() : ''
  const matches = slash
    ? COMMANDS.filter((command) => command.name.startsWith(slash))
    : []

  const mention = running ? null : mentionAt(value, caret)
  const mentionOpen = mention !== null && !dismissed

  useEffect(() => {
    setFiles([])
    setFilesFor(null)
    setActive(0)
    setDismissed(false)
  }, [activeId])

  // The file list is a bounded index from main, fetched on first use per
  // session. It carries paths only; nothing is read until the agent runs.
  useEffect(() => {
    if (!mentionOpen || !activeId || filesFor === activeId) return
    if (!window.api?.workspace?.files) return

    let cancelled = false
    void window.api.workspace
      .files(activeId)
      .then((next) => {
        if (cancelled) return
        setFiles(next)
        setFilesFor(activeId)
      })
      .catch(() => {
        if (!cancelled) setFilesFor(activeId)
      })

    return () => {
      cancelled = true
    }
  }, [mentionOpen, activeId, filesFor])

  const suggestions = useMemo(() => {
    if (!mention || !mentionOpen) return []
    const query = mention.query.toLowerCase()

    const rank = (file: string) => {
      const lower = file.toLowerCase()
      const base = lower.split('/').at(-1) ?? lower
      if (query === '') return 0
      if (base.startsWith(query)) return 0
      if (lower.startsWith(query)) return 1
      return 2
    }

    return files
      .filter((file) => file.toLowerCase().includes(query))
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
      .slice(0, MAX_SUGGESTIONS)
  }, [files, mention, mentionOpen])

  const choice = Math.min(active, Math.max(0, suggestions.length - 1))

  const attached = useMemo(
    () => (files.length > 0 ? mentionTokens(value).filter((path) => files.includes(path)) : []),
    [value, files],
  )

  const acceptMention = (file: string) => {
    if (!mention) return
    const after = value.slice(caret).replace(/^\s+/, '')
    const next = `${value.slice(0, mention.start)}@${file} ${after}`
    const nextCaret = mention.start + file.length + 2

    setValue(next)
    setCaret(nextCaret)
    setActive(0)
    // The insert itself must not reopen the picker for the path just chosen.
    setDismissed(true)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const removeMention = (path: string) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const next = value
      .replace(new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`, 'g'), '$1')
      .replace(/^\s+/, '')
      .replace(/\s+$/, '')

    setValue(next)
    setCaret(next.length)
  }

  // Auto-grow up to ~9 lines, then scroll.
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [value])

  const runCommand = (command: string) => {
    setValue('')
    if (command === '/clear') void newSession()
    if (command === '/compact') void compact()
  }

  const submit = () => {
    const text = value.trim()
    if (!text || running || compacting) return

    // Only these two commands exist, and both are local actions: a slash path
    // that is not a command is still a normal message.
    if (slash === '/clear' || slash === '/compact') {
      runCommand(slash)
      return
    }
    const only = matches.length === 1 ? matches[0] : undefined
    if (only && !slash.includes(' ')) {
      runCommand(only.name)
      return
    }
    if (slash === '/') return

    if (gated) {
      notify('Review and trust the project instructions before running the agent.')
      return
    }
    setValue('')
    void send(text)
  }

  const groups = useMemo(() => {
    const byProvider = new Map<string, typeof models>()
    for (const candidate of models) {
      const list = byProvider.get(candidate.providerId) ?? []
      list.push(candidate)
      byProvider.set(candidate.providerId, list)
    }
    return [...byProvider.entries()]
  }, [models])

  const selected = models.find(
    (candidate) => candidate.providerId === provider && candidate.id === model,
  )
  const modelWindow = selected?.contextWindow ?? 8192
  const selection = `${provider}::${model}`

  const chooseModel = (value: string) => {
    const at = value.indexOf('::')
    if (at < 0) return
    setModel(value.slice(0, at) as ProviderId, value.slice(at + 2))
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
            aria-label="Message"
            onChange={(event) => {
              const next = event.target.value
              setValue(next)
              setCaret(event.target.selectionStart)
              setActive(0)
              // Adding an `@` opens the picker, including a pasted one. Other
              // typing keeps an explicit dismissal in place until then.
              if (countAts(next) > countAts(value)) setDismissed(false)
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (suggestions.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const step = event.key === 'ArrowDown' ? 1 : -1
                  setActive((choice + step + suggestions.length) % suggestions.length)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDismissed(true)
                  return
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault()
                  const picked = suggestions[choice]
                  if (picked) acceptMention(picked)
                  return
                }
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={
              running
                ? 'Working — press stop to interrupt'
                : gated
                  ? 'Review the project instructions above to continue'
                  : 'Ask for a change, or describe a bug…'
            }
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-2 text-[13.5px] leading-[1.55] text-ink outline-none placeholder:text-ink-faint"
          />

          {suggestions.length > 0 && (
            <div
              role="listbox"
              aria-label="Project files"
              className="mx-1 mb-1 overflow-hidden rounded-control border border-line bg-canvas py-0.5"
            >
              {suggestions.map((file, index) => {
                const cut = file.lastIndexOf('/') + 1
                return (
                  <button
                    key={file}
                    type="button"
                    role="option"
                    aria-selected={index === choice}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => acceptMention(file)}
                    className={cn(
                      'flex w-full items-baseline gap-2 px-2 py-[3px] text-left',
                      index === choice && 'bg-panel-2',
                    )}
                  >
                    <span className="truncate font-mono text-[11px]">
                      <span className="text-ink-faint">{file.slice(0, cut)}</span>
                      <span className="text-ink">{file.slice(cut)}</span>
                    </span>
                  </button>
                )
              })}
              <div className="px-2 pt-0.5 pb-1 text-[10px] text-ink-faint">
                ↑↓ choose · ⏎ insert · Esc dismiss
              </div>
            </div>
          )}

          {attached.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2.5 pb-1">
              {attached.map((path) => (
                <span
                  key={path}
                  className="flex items-center gap-1 rounded-control border border-line bg-canvas px-1.5 py-[1px] font-mono text-[10.5px] text-ink-muted"
                >
                  @{path}
                  <button
                    type="button"
                    aria-label={`Remove ${path}`}
                    onClick={() => removeMention(path)}
                    className="text-ink-faint transition-colors hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {matches.length > 0 && !running && (
            <div className="flex flex-wrap gap-1 px-2.5 pb-0.5">
              {matches.map((command) => (
                <button
                  key={command.name}
                  type="button"
                  onClick={() => runCommand(command.name)}
                  className="flex items-baseline gap-1.5 rounded-control border border-line bg-canvas px-2 py-[2px] text-left transition-colors hover:border-line-strong"
                >
                  <span className="font-mono text-[11px] text-ink">{command.name}</span>
                  <span className="text-[10.5px] text-ink-faint">{command.description}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 px-2 pb-2">
            <label className="sr-only" htmlFor="model-picker">
              Model
            </label>
            <select
              id="model-picker"
              value={selection}
              onChange={(event) => chooseModel(event.target.value)}
              disabled={running}
              title="Switch model (⌘K)"
              className="max-w-[180px] cursor-pointer appearance-none truncate rounded-full border border-line bg-canvas px-2 py-[2px] text-[11px] text-ink-muted outline-none transition-colors hover:border-line-strong hover:text-ink disabled:opacity-60"
            >
              {!selected && <option value={selection}>{model}</option>}
              {groups.map(([providerId, list]) => (
                <optgroup key={providerId} label={providerLabel(providerId)}>
                  {list.map((candidate) => (
                    <option
                      key={`${providerId}::${candidate.id}`}
                      value={`${providerId}::${candidate.id}`}
                    >
                      {candidate.label}
                      {candidate.capabilities.nativeTools ? '' : ' · no tools'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <button
              type="button"
              onClick={cycleMode}
              title="Change permission mode"
              className="rounded-full border border-line bg-canvas px-2 py-[2px] text-[11px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              {MODE_LABEL[mode] ?? mode}
            </button>

            <div className="ml-auto flex items-center gap-1.5">
              <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-faint">
                ⏎
              </kbd>
              <button
                type="button"
                onClick={() => (running ? void abort() : submit())}
                aria-label={running ? 'Stop' : 'Send'}
                title={running ? 'Stop (Esc)' : 'Send (⌘⏎)'}
                disabled={!running && (!value.trim() || compacting)}
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

        {retry && <RetryLine retry={retry} />}

        <UsageLine
          usage={usage}
          modelWindow={modelWindow}
          provider={provider}
          showPrefill={showPrefill}
          compacting={compacting}
          canCompact={!running}
          onCompact={() => void compact()}
        />
      </div>
    </div>
  )
}

function RetryLine({ retry }: { retry: RetryState }) {
  const seconds = Math.max(1, Math.ceil(retry.waitMs / 1_000))

  return (
    <div
      role="status"
      className="mt-1.5 flex items-center gap-2 px-1 text-[10.5px] text-ink-muted"
    >
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warn" />
      <span>
        {retryLabel(retry.errorClass)} · retrying in{' '}
        <span className="tabular-nums">{seconds}s</span>
      </span>
      <span className="text-ink-faint">
        attempt {retry.attempt} of {retry.maxAttempts}
      </span>
      <span className="ml-auto text-ink-faint">Esc stops</span>
    </div>
  )
}

function UsageLine({
  usage,
  modelWindow,
  provider,
  showPrefill,
  compacting,
  canCompact,
  onCompact,
}: {
  usage: {
    promptTokens: number
    outputTokens: number
    contextPct: number
    contextWindow: number
    cachedTokens: number
  } | null
  modelWindow: number
  provider: string
  showPrefill: boolean
  compacting: boolean
  canCompact: boolean
  onCompact: () => void
}) {
  const used = usage ? usage.promptTokens + usage.outputTokens : 0
  const contextWindow = usage?.contextWindow ?? modelWindow
  const pct = usage ? Math.round(usage.contextPct * 100) : 0
  const cachedShare =
    usage && usage.promptTokens > 0 ? usage.cachedTokens / usage.promptTokens : 0
  const cachedPct = Math.round(cachedShare * 100)
  const prefill =
    showPrefill && usage && used > 0 ? prefillSeconds(used, cachedShare) : null

  return (
    <div className="mt-1.5 flex items-center gap-2 px-1 text-[10.5px] text-ink-faint">
      <div className="h-[3px] w-24 overflow-hidden rounded-full bg-line">
        <div
          className={cn('h-full rounded-full transition-[width]', pct > 85 ? 'bg-warn' : 'bg-clay')}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>

      {usage ? (
        <>
          <span className="tabular-nums">
            {used.toLocaleString()} / {contextWindow.toLocaleString()} tokens
          </span>
          <span>·</span>
          <span className="tabular-nums">{cachedPct}% cached</span>
          <span>·</span>
          <span className="tabular-nums">{pct}% ctx</span>
          {prefill !== null && (
            <>
              <span>·</span>
              <span
                className="tabular-nums"
                title="Estimated from the measured cold and cached prefill speeds, not a live timer"
              >
                prefill {formatWait(prefill)}
              </span>
            </>
          )}
        </>
      ) : (
        <span>Ready</span>
      )}

      {(compacting || (usage && pct >= 55)) && (
        <button
          type="button"
          onClick={onCompact}
          disabled={!canCompact || compacting}
          title="Summarize earlier turns to free context"
          className={cn(
            'rounded border border-line px-1.5 py-[1px] text-[10.5px] transition-colors',
            compacting
              ? 'animate-pulse text-ink-muted'
              : 'text-ink-muted hover:border-line-strong hover:text-ink disabled:opacity-50',
          )}
        >
          {compacting ? 'Compacting…' : 'Compact'}
        </button>
      )}

      <span className="ml-auto">
        {provider === 'ollama' ? 'local · $0.00' : 'external endpoint'}
      </span>
    </div>
  )
}
