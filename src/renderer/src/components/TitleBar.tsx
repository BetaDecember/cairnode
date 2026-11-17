import { cn } from '../lib/cn'
import { Layers, Moon, Plus, Sun } from './icons'

interface Props {
  title: string
  theme: 'light' | 'dark'
  view: 'app' | 'gallery'
  onToggleTheme: () => void
  onToggleView: () => void
}

export function TitleBar({ title, theme, view, onToggleTheme, onToggleView }: Props) {
  return (
    <header className="drag-region grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-line bg-canvas px-[76px]">
      <div />
      <div className="max-w-[50vw] truncate text-[12px] font-medium text-ink-muted">{title}</div>
      <div className="no-drag flex items-center justify-end gap-0.5">
        <IconButton
          label={view === 'gallery' ? 'Back to session' : 'Component gallery'}
          onClick={onToggleView}
          active={view === 'gallery'}
        >
          <Layers size={15} />
        </IconButton>
        <IconButton
          label={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
          onClick={onToggleTheme}
        >
          {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
        </IconButton>
      </div>
    </header>
  )
}

function IconButton({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-control text-ink-muted transition-colors',
        active ? 'bg-panel-2 text-ink' : 'hover:bg-panel-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

export function NewSessionButton() {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-control border border-line bg-panel px-2 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-panel-2"
    >
      <Plus size={13} />
      New
    </button>
  )
}
