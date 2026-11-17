import { useMemo, useState } from 'react'
import { sessions } from '../lib/fixtures'
import { cn } from '../lib/cn'
import { Search } from './icons'
import { NewSessionButton } from './TitleBar'

export function Sidebar() {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q),
        )
      : sessions

    const byGroup = new Map<string, typeof sessions>()
    for (const s of filtered) {
      const list = byGroup.get(s.group) ?? []
      list.push(s)
      byGroup.set(s.group, list)
    }
    return [...byGroup.entries()]
  }, [query])

  return (
    <aside className="flex w-[262px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-ink">recode</span>
        </div>
        <NewSessionButton />
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-control border border-line bg-canvas px-2 py-[5px]">
          <Search size={13} className="shrink-0 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map(([group, items]) => (
          <div key={group} className="mb-2">
            <div className="px-2 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
              {group}
            </div>
            <ul className="space-y-px">
              {items.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cn(
                      'group w-full rounded-control px-2 py-[7px] text-left transition-colors',
                      s.active ? 'bg-clay-soft' : 'hover:bg-panel-2',
                    )}
                  >
                    <div
                      className={cn(
                        'truncate text-[12.5px] leading-[1.4]',
                        s.active ? 'font-medium text-clay' : 'text-ink',
                      )}
                    >
                      {s.title}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] leading-[1.3] text-ink-faint">
                      {s.preview}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-ink-faint">No sessions match.</p>
        )}
      </nav>

      <div className="border-t border-line px-3 py-2.5">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left transition-colors hover:bg-panel-2"
        >
          <span className="size-1.5 rounded-full bg-ok" />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted">
            qwen3.5:4b
          </span>
          <span className="text-[10.5px] text-ink-faint">local</span>
        </button>
      </div>
    </aside>
  )
}

/** Original mark: a rounded tile with a nested cut, not a letterform. */
function BrandMark() {
  return (
    <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-clay">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 7.4V2.6h3.1a2.1 2.1 0 0 1 0 4.2H2" stroke="#fff" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  )
}
