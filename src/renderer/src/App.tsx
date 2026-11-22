import { useEffect } from 'react'
import { Composer } from './components/Composer'
import { Gallery } from './components/Gallery'
import { ProjectMemoryBar } from './components/ProjectMemory'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Transcript } from './components/Transcript'
import { useApp } from './state/store'

export default function App() {
  const booted = useApp((state) => state.booted)
  const boot = useApp((state) => state.boot)
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const theme = useApp((state) => state.theme)
  const toggleTheme = useApp((state) => state.toggleTheme)
  const title = useApp((state) => {
    const active = state.sessions.find((session) => session.id === state.activeId)
    return active?.title ?? 'New session'
  })
  const cwd = useApp((state) => state.cwd)
  const notice = useApp((state) => state.notice)
  const dismissNotice = useApp((state) => state.dismissNotice)
  const openSettings = useApp((state) => state.openSettings)

  useEffect(() => {
    void boot()
  }, [boot])

  // Shortcuts are global: the composer is not always focused, and stopping a
  // run should work from anywhere in the window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useApp.getState()
      // The settings dialog owns Escape and its own fields.
      if (state.settingsOpen) return

      if (event.key === 'Escape') {
        if (state.running) {
          event.preventDefault()
          void state.abort()
        }
        return
      }

      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (state.view !== 'app') return

      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        void state.newSession()
        return
      }

      if (key === 'k' && !state.running) {
        event.preventDefault()
        const picker = document.getElementById('model-picker')
        if (!(picker instanceof HTMLSelectElement)) return
        picker.focus()
        try {
          const native = picker as HTMLSelectElement & { showPicker?: () => void }
          native.showPicker?.()
        } catch {
          // Focusing is enough if the browser refuses the native popup.
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <TitleBar
        title={booted ? title : 'Cairnode'}
        cwd={cwd}
        theme={theme}
        view={view}
        onToggleTheme={toggleTheme}
        onToggleView={() => setView(view === 'app' ? 'gallery' : 'app')}
        onOpenSettings={() => void openSettings()}
      />

      {notice && (
        <div className="flex items-center gap-3 border-b border-warn/30 bg-warn/8 px-4 py-1.5 text-[12px] text-ink">
          <span className="size-1.5 shrink-0 rounded-full bg-warn" />
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button
            type="button"
            onClick={dismissNotice}
            className="shrink-0 text-[11.5px] text-ink-muted transition-colors hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col bg-canvas">
          {view === 'app' ? (
            <>
              <ProjectMemoryBar />
              <Transcript />
              <ResumeBar />
              <Composer />
            </>
          ) : (
            <Gallery />
          )}
        </main>
      </div>

      <SettingsDialog />
    </div>
  )
}

/**
 * A session restored from disk can stop in the middle of a turn: the process
 * died, or the run was interrupted after its last saved message. Nothing is
 * running, and the next message picks up from the stored history.
 */
function ResumeBar() {
  const resumable = useApp((state) => state.resumable)
  const running = useApp((state) => state.running)
  const activeId = useApp((state) => state.activeId)

  if (!resumable || running || !activeId) return null

  return (
    <div className="shrink-0 px-6 pb-2">
      <div className="mx-auto flex w-full max-w-[760px] items-start gap-2 rounded-control border border-line bg-panel-2/60 px-3 py-2 text-[11.5px] leading-[1.5] text-ink-muted">
        <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-clay" />
        <span>
          The last turn did not finish.{' '}
          <span className="text-ink">Send a message to continue where it stopped.</span>
        </span>
      </div>
    </div>
  )
}
