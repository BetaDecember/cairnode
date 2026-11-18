import { useEffect, useState } from 'react'
import type { ProjectMemoryStatus } from '@core/api'
import { cn } from '../lib/cn'
import { shortPath } from '../lib/path'
import { useApp } from '../state/store'
import { File, X } from './icons'

/**
 * A slim status row plus the review surface for project instructions.
 *
 * Trust is bound to the exact bytes the user sees. If the files change, the
 * row turns back into a gate until they are reviewed again.
 */
export function ProjectMemoryBar() {
  const memory = useApp((state) => state.memory)
  const activeId = useApp((state) => state.activeId)
  const [openFor, setOpenFor] = useState<string | null>(null)

  // Switching sessions must not leave another project's instructions open.
  useEffect(() => {
    setOpenFor(null)
  }, [activeId])

  if (!memory) return null

  const hasFiles = memory.files.length > 0
  const gated = hasFiles && memory.trust !== 'trusted'
  if (!hasFiles && memory.warnings.length === 0) return null

  const open = openFor === memory.cwd

  return (
    <>
      <div className="shrink-0 px-6 pt-3">
        <div
          className={cn(
            'mx-auto flex w-full max-w-[760px] items-center gap-2 rounded-control border px-3 py-1.5 text-[11.5px]',
            gated
              ? 'border-warn/40 bg-warn/8 text-ink'
              : 'border-line bg-panel-2/40 text-ink-muted',
          )}
        >
          <File size={12} className={gated ? 'shrink-0 text-clay' : 'shrink-0 text-ink-faint'} />
          <span className="min-w-0 flex-1 truncate">
            {hasFiles ? (
              gated ? (
                memory.trust === 'changed' ? (
                  <>
                    Project instructions changed since you trusted them.{' '}
                    <span className="text-ink">Review them before running.</span>
                  </>
                ) : (
                  <>
                    This project has instructions the agent will follow.{' '}
                    <span className="text-ink">Review them before running.</span>
                  </>
                )
              ) : (
                <>
                  Project instructions loaded · {memory.files.map((file) => file.name).join(', ')}
                </>
              )
            ) : (
              <>
                {memory.warnings[0]?.name} {memory.warnings[0]?.reason}.
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => setOpenFor(open ? null : memory.cwd)}
            className="shrink-0 rounded border border-line px-1.5 py-[1px] text-[10.5px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {gated ? 'Review' : 'View'}
          </button>
        </div>
      </div>

      {open && (
        <ProjectMemoryDialog
          memory={memory}
          onClose={() => {
            setOpenFor(null)
          }}
        />
      )}
    </>
  )
}

function ProjectMemoryDialog({
  memory,
  onClose,
}: {
  memory: ProjectMemoryStatus
  onClose: () => void
}) {
  const trustMemory = useApp((state) => state.trustMemory)
  const [busy, setBusy] = useState(false)
  const gated = memory.files.length > 0 && memory.trust !== 'trusted'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const confirm = async () => {
    setBusy(true)
    const trusted = await trustMemory()
    setBusy(false)
    if (trusted) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-memory-title"
        className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-panel border border-line bg-panel shadow-[0_24px_70px_-20px_rgba(0,0,0,0.45)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 id="project-memory-title" className="text-[13.5px] font-medium text-ink">
              Project instructions
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" title={memory.cwd}>
              {shortPath(memory.cwd)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close project instructions"
            className="shrink-0 rounded-control p-1 text-ink-faint transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <p className="text-[11.5px] leading-[1.65] text-ink-muted">
            These files are added to the system prompt for every message in this project. They
            can describe how the project works, but they cannot grant the agent new permissions:
            tools still ask according to the permission mode.
            {gated && (
              <span className="text-ink">
                {' '}
                Read them before trusting the project.
              </span>
            )}
          </p>

          {memory.warnings.map((warning) => (
            <div
              key={`${warning.name}:${warning.reason}`}
              className="rounded-control border border-warn/30 bg-warn/8 px-3 py-2 text-[11.5px] leading-relaxed text-ink-muted"
            >
              <span className="font-medium text-ink">{warning.name}</span> {warning.reason}.
            </div>
          ))}

          {memory.files.map((file) => (
            <section key={file.name} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <File size={12} className="shrink-0 text-ink-faint" />
                <h3 className="text-[11.5px] font-semibold text-ink">{file.name}</h3>
                <span className="text-[10.5px] tabular-nums text-ink-faint">
                  {file.bytes.toLocaleString()} bytes
                </span>
                {file.truncated && (
                  <span className="rounded border border-warn/30 bg-warn/8 px-1.5 py-[1px] text-[10px] text-ink-muted">
                    truncated
                  </span>
                )}
              </div>
              <pre className="max-h-[340px] overflow-auto rounded-control border border-line bg-canvas px-3 py-2.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-ink">
                {file.content}
              </pre>
            </section>
          ))}

          {memory.files.length === 0 && memory.warnings.length === 0 && (
            <p className="text-[11.5px] text-ink-faint">
              There are no instruction files in this project.
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-control border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            {gated ? 'Cancel' : 'Close'}
          </button>
          {gated && (
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className="rounded-control bg-clay px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Trusting…' : 'Trust this project'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
