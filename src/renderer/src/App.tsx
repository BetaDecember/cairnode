import { useEffect, useState } from 'react'
import { Composer } from './components/Composer'
import { Gallery } from './components/Gallery'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Transcript } from './components/Transcript'
import { transcript } from './lib/fixtures'

type Theme = 'light' | 'dark'

/** `?theme=dark&view=gallery` — makes the UI directly addressable for visual checks. */
function readParams(): { theme: Theme; view: 'app' | 'gallery' } {
  const params = new URLSearchParams(window.location.search)
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const view = params.get('view') === 'gallery' ? 'gallery' : 'app'
  return { theme, view }
}

export default function App() {
  const initial = readParams()
  const [theme, setTheme] = useState<Theme>(initial.theme)
  const [view, setView] = useState<'app' | 'gallery'>(initial.view)

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <TitleBar
        title="Add /health endpoint"
        theme={theme}
        view={view}
        onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        onToggleView={() => setView((v) => (v === 'app' ? 'gallery' : 'app'))}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col bg-canvas">
          {view === 'app' ? (
            <>
              <Transcript items={transcript} />
              <Composer running />
            </>
          ) : (
            <Gallery />
          )}
        </main>
      </div>
    </div>
  )
}
