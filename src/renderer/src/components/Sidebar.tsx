import { useMemo, useState } from 'react'
import type { SessionMeta } from '@core/types'
import { cn } from '../lib/cn'
import { useApp } from '../state/store'
import { Folder, Search, X } from './icons'
import { NewSessionButton } from './TitleBar'

const GROUPS = ['Today', 'Yesterday', 'Earlier'] as const
type Group = (typeof GROUPS)[number]

/**
 * Calendar-day grouping, not elapsed-hours: a session from 11pm last night
 * belongs under Yesterday even though it is only two hours old.
 */
function groupFor(iso: string, now: number): Group {
  const at = new Date(iso)
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
  const today = new Date(now)
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime()

  if (midnight >= startOfToday) return 'Today'
  if (midnight >= startOfToday - 86_400_000) return 'Yesterday'
  return 'Earlier'
}

export function Sidebar() {
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const sessions = useApp((state) => state.sessions)
  const activeId = useApp((state) => state.activeId)
  const running = useApp((state) => state.running)
  const openSession = useApp((state) => state.openSession)
  const deleteSession = useApp((state) => state.deleteSession)
  const chooseFolder = useApp((state) => state.chooseFolder)
  const model = useApp((state) => state.model)
  const models = useApp((state) => state.models)

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? sessions.filter(
          (session) =>
            session.title.toLowerCase().includes(needle) ||
            session.preview.toLowerCase().includes(needle) ||
            session.cwd.toLowerCase().includes(needle),
        )
      : sessions

    const now = Date.now()
    const buckets = new Map<Group, SessionMeta[]>()
    for (const session of filtered) {
      const group = groupFor(session.updatedAt, now)
      const bucket = buckets.get(group) ?? []
      bucket.push(session)
      buckets.set(group, bucket)
    }

    return GROUPS.flatMap((group) => {
      const items = buckets.get(group)
      return items && items.length > 0 ? ([[group, items]] as const) : []
    })
  }, [sessions, query])

  const activeModel = models.find((candidate) => candidate.id === model)

  return (
    <aside className="flex w-[262px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-ink">recode</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void chooseFolder()}
            title="Open a project folder"
            aria-label="Open a project folder"
            className="flex size-[26px] items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink"
          >
            <Folder size={14} />
          </button>
          <NewSessionButton />
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-control border border-line bg-canvas px-2 py-[5px]">
          <Search size={13} className="shrink-0 text-ink-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="shrink-0 text-ink-faint transition-colors hover:text-ink"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map(([group, items]) => (
          <div key={group} className="mb-2">
            <div className="px-2 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
              {group}
            </div>
            <ul className="space-y-px">
              {items.map((session) => {
                const active = session.id === activeId
                const confirming = session.id === confirmId

                return (
                  <li key={session.id} className="group/row relative">
                    <button
                      type="button"
                      disabled={running && !active}
                      onClick={() => void openSession(session.id)}
                      title={
                        running && !active
                          ? 'Wait for the current run to finish'
                          : session.cwd
                      }
                      className={cn(
                        'w-full rounded-control px-2 py-[7px] pr-7 text-left transition-colors',
                        active ? 'bg-clay-soft' : 'hover:bg-panel-2',
                        running && !active && 'opacity-50',
                      )}
                    >
                      <div
                        className={cn(
                          'truncate text-[12.5px] leading-[1.4]',
                          active ? 'font-medium text-clay' : 'text-ink',
                        )}
                      >
                        {session.title}
                      </div>
                      <div className="mt-0.5 truncate text-[11.5px] leading-[1.3] text-ink-faint">
                        {confirming ? 'Delete this session?' : session.preview}
                      </div>
                    </button>

                    {confirming ? (
                      <div className="absolute inset-y-0 right-1 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmId(null)
                            void deleteSession(session.id)
                          }}
                          className="rounded-control bg-danger px-1.5 py-0.5 text-[10.5px] font-medium text-white transition-opacity hover:opacity-90"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          className="rounded-control border border-line bg-panel px-1.5 py-0.5 text-[10.5px] text-ink-muted transition-colors hover:text-ink"
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmId(session.id)}
                        title="Delete session"
                        aria-label={`Delete ${session.title}`}
                        className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-ink-faint opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-panel-2 hover:text-danger focus-visible:opacity-100"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}

        {sessions.length === 0 && (
          <div className="px-3 py-6 text-center">
            <p className="text-[12px] text-ink-faint">No sessions yet.</p>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="mt-2 text-[12px] font-medium text-clay transition-opacity hover:opacity-80"
            >
              Choose a project folder
            </button>
          </div>
        )}

        {sessions.length > 0 && groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-ink-faint">No sessions match.</p>
        )}
      </nav>

      <div className="border-t border-line px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-control px-1.5 py-1">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              activeModel ? 'bg-ok' : 'bg-warn',
            )}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
            {activeModel?.label ?? model}
          </span>
          <span className="shrink-0 text-[10.5px] text-ink-faint">
            {activeModel ? 'local' : 'offline'}
          </span>
        </div>
      </div>
    </aside>
  )
}

/** Original mark: a rounded tile with a nested cut, not a letterform. */
function BrandMark() {
  return (
    <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-clay">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M2 7.4V2.6h3.1a2.1 2.1 0 0 1 0 4.2H2"
          stroke="#fff"
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}
