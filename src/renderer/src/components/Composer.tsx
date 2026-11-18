import { useEffect, useMemo, useRef, useState } from 'react'
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

export function Composer() {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const running = useApp((state) => state.running)
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
  const memory = useApp((state) => state.memory)
  const notify = useApp((state) => state.notify)

  const gated = Boolean(memory && memory.files.length > 0 && memory.trust !== 'trusted')
  const slash = value.trimStart().startsWith('/') ? value.trim().toLowerCase() : ''
  const matches = slash
    ? COMMANDS.filter((command) => command.name.startsWith(slash))
    : []

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
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
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

        <UsageLine
          usage={usage}
          modelWindow={modelWindow}
          provider={provider}
          compacting={compacting}
          canCompact={!running}
          onCompact={() => void compact()}
        />
      </div>
    </div>
  )
}

function UsageLine({
  usage,
  modelWindow,
  provider,
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
  compacting: boolean
  canCompact: boolean
  onCompact: () => void
}) {
  const used = usage ? usage.promptTokens + usage.outputTokens : 0
  const contextWindow = usage?.contextWindow ?? modelWindow
  const pct = usage ? Math.round(usage.contextPct * 100) : 0
  const cachedPct =
    usage && usage.promptTokens > 0
      ? Math.round((usage.cachedTokens / usage.promptTokens) * 100)
      : 0

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
