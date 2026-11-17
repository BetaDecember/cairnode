import { create } from 'zustand'
import type {
  AgentEvent,
  ModelInfo,
  PermissionMode,
  SessionMeta,
  SessionState,
} from '@core/types'
import type { PermissionDecision } from '@core/agent/permission'
import {
  beginTurn,
  emptyFold,
  foldMessages,
  reduce,
  resetIds,
  resolvePermission,
  type Fold,
} from '../lib/fold'

type Theme = 'light' | 'dark'
type View = 'app' | 'gallery'

const THEME_KEY = 'recode.theme'
const MODEL_KEY = 'recode.model'
const FALLBACK_MODEL = 'qwen3.5:4b'

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass']

function readTheme(): Theme {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('theme')
  if (fromQuery === 'dark' || fromQuery === 'light') return fromQuery
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
}

function readView(): View {
  return new URLSearchParams(window.location.search).get('view') === 'gallery'
    ? 'gallery'
    : 'app'
}

interface AppState {
  booted: boolean
  theme: Theme
  view: View
  sessions: SessionMeta[]
  activeId: string | null
  cwd: string | null
  fold: Fold
  running: boolean
  compacting: boolean
  sessionState: SessionState
  models: ModelInfo[]
  model: string
  mode: PermissionMode
  notice: string | null

  boot(): Promise<void>
  setTheme(theme: Theme): void
  toggleTheme(): void
  setView(view: View): void
  setModel(id: string): void
  cycleMode(): void
  dismissNotice(): void

  refreshSessions(): Promise<void>
  newSession(): Promise<void>
  chooseFolder(): Promise<void>
  openSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>

  send(text: string): Promise<void>
  abort(): Promise<void>
  compact(): Promise<void>
  respond(requestId: string, decision: PermissionDecision): Promise<void>
  handleEvent(payload: { sessionId: string; event: AgentEvent }): void
}

async function ensureSession(get: () => AppState, set: (partial: Partial<AppState>) => void): Promise<string | null> {
  const current = get().activeId
  if (current) return current

  try {
    const meta = await window.api.sessions.create(get().cwd ?? undefined)
    resetIds()
    set({ activeId: meta.id, cwd: meta.cwd, fold: emptyFold() })
    await get().refreshSessions()
    return meta.id
  } catch (error) {
    set({ notice: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export const useApp = create<AppState>((set, get) => ({
  booted: false,
  theme: readTheme(),
  view: readView(),
  sessions: [],
  activeId: null,
  cwd: null,
  fold: emptyFold(),
  running: false,
  compacting: false,
  sessionState: 'idle',
  models: [],
  model: localStorage.getItem(MODEL_KEY) ?? FALLBACK_MODEL,
  mode: 'default',
  notice: null,

  async boot() {
    if (get().booted) return

    const theme = readTheme()
    document.documentElement.dataset['theme'] = theme
    set({ booted: true, theme, view: readView() })

    // The renderer also runs in a plain browser during design work, where the
    // preload bridge does not exist. Render the shell instead of crashing.
    if (!window.api) return

    window.api.chat.onEvent((payload) => get().handleEvent(payload))

    const [models, sessions] = await Promise.all([
      window.api.models().catch(() => [] as ModelInfo[]),
      window.api.sessions.list().catch(() => [] as SessionMeta[]),
    ])

    const stored = localStorage.getItem(MODEL_KEY)
    const model =
      models.find((candidate) => candidate.id === stored)?.id ??
      models.find((candidate) => candidate.capabilities.nativeTools)?.id ??
      models[0]?.id ??
      FALLBACK_MODEL

    set({
      models,
      sessions,
      model,
      notice: models.length === 0 ? 'No models found. Is Ollama running?' : null,
    })

    const first = sessions[0]
    if (first) await get().openSession(first.id)
  },

  setTheme(theme) {
    document.documentElement.dataset['theme'] = theme
    localStorage.setItem(THEME_KEY, theme)
    set({ theme })
  },

  toggleTheme() {
    get().setTheme(get().theme === 'light' ? 'dark' : 'light')
  },

  setView(view) {
    set({ view })
  },

  setModel(id) {
    localStorage.setItem(MODEL_KEY, id)
    set({ model: id })
  },

  cycleMode() {
    const index = MODES.indexOf(get().mode)
    const next = MODES[(index + 1) % MODES.length] ?? 'default'
    set({ mode: next })
  },

  dismissNotice() {
    set({ notice: null })
  },

  async refreshSessions() {
    const sessions = await window.api.sessions.list().catch(() => get().sessions)
    set({ sessions })
  },

  async newSession() {
    if (!get().cwd) {
      await get().chooseFolder()
      return
    }

    try {
      const meta = await window.api.sessions.create(get().cwd ?? undefined)
      resetIds()
      set({
        activeId: meta.id,
        fold: emptyFold(),
        running: false,
        compacting: false,
        sessionState: 'idle',
      })
      await get().refreshSessions()
    } catch (error) {
      set({ notice: error instanceof Error ? error.message : String(error) })
    }
  },

  async chooseFolder() {
    try {
      const picked = await window.api.workspace.pick()
      if (!picked) return

      const meta = await window.api.sessions.create(picked)
      resetIds()
      set({
        cwd: picked,
        activeId: meta.id,
        fold: emptyFold(),
        running: false,
        compacting: false,
        sessionState: 'idle',
      })
      await get().refreshSessions()
    } catch (error) {
      set({ notice: error instanceof Error ? error.message : String(error) })
    }
  },

  async openSession(id) {
    if (get().running) return

    const record = await window.api.sessions.load(id)
    if (!record) return

    set({
      activeId: id,
      cwd: record.meta.cwd,
      fold: foldMessages(record.messages, record.compactions),
      running: false,
      compacting: false,
      sessionState: 'idle',
    })
  },

  async deleteSession(id) {
    await window.api.sessions.remove(id)
    const sessions = await window.api.sessions.list().catch(() => [])
    set({ sessions })

    if (get().activeId !== id) return

    const next = sessions[0]
    if (next) await get().openSession(next.id)
    else set({ activeId: null, fold: emptyFold(), cwd: null })
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed || get().running) return

    const sessionId = await ensureSession(get, set)
    if (!sessionId) return

    set({
      fold: beginTurn(get().fold, trimmed),
      running: true,
      sessionState: 'thinking',
    })
    void get().refreshSessions()

    try {
      await window.api.chat.send({
        sessionId,
        text: trimmed,
        model: get().model,
        mode: get().mode,
      })
      set({ notice: null })
    } catch (error) {
      set({
        running: false,
        sessionState: 'idle',
        notice: error instanceof Error ? error.message : String(error),
      })
    }
  },

  async abort() {
    const id = get().activeId
    if (!id) return
    await window.api.chat.abort(id)
  },

  async compact() {
    const id = get().activeId
    if (!id || get().running || get().compacting) return

    set({ compacting: true })
    try {
      await window.api.chat.compact({ sessionId: id, model: get().model })
      set({ notice: null })
    } catch (error) {
      set({ notice: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ compacting: false })
    }
  },

  async respond(requestId, decision) {
    set({
      fold: resolvePermission(
        get().fold,
        requestId,
        decision === 'deny' ? 'denied' : 'allowed',
      ),
    })
    await window.api.chat.respond({ requestId, decision })
  },

  handleEvent({ sessionId, event }) {
    if (sessionId !== get().activeId) return

    if (event.type === 'session_state') {
      set({ sessionState: event.state })
      return
    }

    set({ fold: reduce(get().fold, event) })

    if (event.type === 'done') {
      set({ running: false, sessionState: 'idle' })
      void get().refreshSessions()
    }
  },
}))

export type { AppState, Theme, View }
