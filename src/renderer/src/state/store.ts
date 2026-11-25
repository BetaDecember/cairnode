import { create } from 'zustand'
import type {
  AgentEvent,
  ErrorClass,
  ModelInfo,
  PermissionMode,
  SessionMeta,
  SessionState,
} from '@core/types'
import type { ProjectMemoryStatus } from '@core/api'
import type { ProviderId, Settings, SettingsPatch } from '@core/settings'
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

const THEME_KEY = 'cairnode.theme'
const PROVIDER_KEY = 'cairnode.provider'
const MODEL_KEY_PREFIX = 'cairnode.model.'
/** Written by versions that only knew about Ollama. */
const LEGACY_MODEL_KEY = 'cairnode.model'
const FALLBACK_MODEL = 'qwen3.5:4b'
const NO_MODELS_NOTICE = 'No models found. Check Settings.'

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

function readProvider(): ProviderId {
  return localStorage.getItem(PROVIDER_KEY) === 'openai' ? 'openai' : 'ollama'
}

function readModel(providerId: ProviderId): string | null {
  const saved = localStorage.getItem(`${MODEL_KEY_PREFIX}${providerId}`)
  if (saved) return saved
  return providerId === 'ollama' ? localStorage.getItem(LEGACY_MODEL_KEY) : null
}

function writeSelection(providerId: ProviderId, model: string): void {
  localStorage.setItem(PROVIDER_KEY, providerId)
  localStorage.setItem(`${MODEL_KEY_PREFIX}${providerId}`, model)
}

/**
 * Pick a model that exists in the current listing.
 *
 * The remembered choice wins when it is still offered; otherwise prefer a
 * model that can call tools, then anything from the requested provider, then
 * any provider at all. Keeping a stale id is better than an empty picker when
 * the server is simply down.
 */
function chooseSelection(
  models: ModelInfo[],
  preferredProvider: ProviderId,
  preferredModel: string | null,
): { provider: ProviderId; model: string } {
  const preferred = models.filter((model) => model.providerId === preferredProvider)

  if (preferredModel && preferred.some((model) => model.id === preferredModel)) {
    return { provider: preferredProvider, model: preferredModel }
  }

  const firstPreferred = preferred.find((model) => model.capabilities.nativeTools) ?? preferred[0]
  if (firstPreferred) return { provider: preferredProvider, model: firstPreferred.id }

  for (const providerId of ['ollama', 'openai'] as const) {
    const candidates = models.filter((model) => model.providerId === providerId)
    const first = candidates.find((model) => model.capabilities.nativeTools) ?? candidates[0]
    if (first) return { provider: providerId, model: first.id }
  }

  return {
    provider: preferredProvider,
    model: preferredModel ?? FALLBACK_MODEL,
  }
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
  /** The active session stopped mid-turn; sending continues it. */
  resumable: boolean
  compacting: boolean
  sessionState: SessionState
  models: ModelInfo[]
  settings: Settings | null
  settingsOpen: boolean
  provider: ProviderId
  model: string
  mode: PermissionMode
  notice: string | null
  /** A retryable provider failure is being waited out. */
  retry: {
    errorClass: ErrorClass
    attempt: number
    maxAttempts: number
    waitMs: number
  } | null
  /** Project instructions and whether this exact content has been trusted. */
  memory: ProjectMemoryStatus | null

  boot(): Promise<void>
  setTheme(theme: Theme): void
  toggleTheme(): void
  setView(view: View): void
  setModel(providerId: ProviderId, id: string): void
  cycleMode(): void
  dismissNotice(): void
  notify(message: string): void
  refreshMemory(sessionId?: string): Promise<void>
  trustMemory(): Promise<boolean>
  openSettings(): Promise<void>
  closeSettings(): void
  saveSettings(patch: SettingsPatch): Promise<void>
  refreshModels(): Promise<void>

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

  // A session is always rooted at a folder the user picked. If this is the
  // first run, open the picker now instead of failing the send.
  const cwd = get().cwd
  if (!cwd) {
    await get().chooseFolder()
    return get().activeId
  }

  try {
    const meta = await window.api.sessions.create(cwd)
    resetIds()
    set({ activeId: meta.id, cwd: meta.cwd, fold: emptyFold(), retry: null, memory: null })
    await get().refreshSessions()
    await get().refreshMemory(meta.id)
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
  resumable: false,
  compacting: false,
  sessionState: 'idle',
  models: [],
  settings: null,
  settingsOpen: false,
  provider: readProvider(),
  model: readModel(readProvider()) ?? FALLBACK_MODEL,
  mode: 'default',
  notice: null,
  retry: null,
  memory: null,

  async boot() {
    if (get().booted) return

    const theme = readTheme()
    document.documentElement.dataset['theme'] = theme
    set({ booted: true, theme, view: readView() })

    // The renderer also runs in a plain browser during design work, where the
    // preload bridge does not exist. Render the shell instead of crashing.
    if (!window.api) return

    window.api.chat.onEvent((payload) => get().handleEvent(payload))

    const [settings, models, sessions] = await Promise.all([
      window.api.settings.get().catch(() => null),
      window.api.models().catch(() => [] as ModelInfo[]),
      window.api.sessions.list().catch(() => [] as SessionMeta[]),
    ])

    const provider = readProvider()
    const selection = chooseSelection(models, provider, readModel(provider))

    set({
      settings,
      models,
      sessions,
      provider: selection.provider,
      model: selection.model,
      notice: models.length === 0 ? NO_MODELS_NOTICE : null,
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

  setModel(providerId, id) {
    writeSelection(providerId, id)
    set({ provider: providerId, model: id })
  },

  cycleMode() {
    const index = MODES.indexOf(get().mode)
    const next = MODES[(index + 1) % MODES.length] ?? 'default'
    set({ mode: next })
  },

  dismissNotice() {
    set({ notice: null })
  },

  notify(message) {
    set({ notice: message })
  },

  async refreshMemory(sessionId) {
    const id = sessionId ?? get().activeId
    if (!id) {
      set({ memory: null })
      return
    }

    try {
      const memory = await window.api.memory.status(id)
      // The user can switch sessions while the read is in flight.
      if (get().activeId === id) set({ memory })
    } catch {
      // Keep the last known state. Main re-checks before a run either way.
    }
  },

  async trustMemory() {
    const id = get().activeId
    const memory = get().memory
    if (!id || !memory || memory.files.length === 0) return false

    try {
      const result = await window.api.memory.trust({
        sessionId: id,
        fingerprint: memory.fingerprint,
      })
      if (get().activeId !== id) return false

      set({
        memory: result.status,
        notice: result.trusted
          ? null
          : 'The project instructions changed. Review them again before continuing.',
      })
      return result.trusted
    } catch (error) {
      set({ notice: error instanceof Error ? error.message : String(error) })
      return false
    }
  },

  async openSettings() {
    if (!get().settings) {
      try {
        const settings = await window.api.settings.get()
        set({ settings })
      } catch (error) {
        set({ notice: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    set({ settingsOpen: true })
  },

  closeSettings() {
    set({ settingsOpen: false })
  },

  async saveSettings(patch) {
    const settings = await window.api.settings.save(patch)
    set({ settings })
    await get().refreshModels()
  },

  async refreshModels() {
    let models: ModelInfo[]
    try {
      models = await window.api.models()
    } catch {
      return
    }

    const selection = chooseSelection(models, get().provider, get().model)
    set({
      models,
      provider: selection.provider,
      model: selection.model,
      notice:
        models.length === 0
          ? NO_MODELS_NOTICE
          : get().notice === NO_MODELS_NOTICE
            ? null
            : get().notice,
    })
  },

  async refreshSessions() {
    const sessions = await window.api.sessions.list().catch(() => get().sessions)
    set({ sessions })
  },

  async newSession() {
    if (get().running) {
      set({ notice: 'Stop the current run before starting a new session.' })
      return
    }
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
        resumable: false,
        compacting: false,
        sessionState: 'idle',
        retry: null,
        memory: null,
      })
      await get().refreshSessions()
      await get().refreshMemory(meta.id)
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
        resumable: false,
        compacting: false,
        sessionState: 'idle',
        retry: null,
        memory: null,
      })
      await get().refreshSessions()
      await get().refreshMemory(meta.id)
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
      running: record.running,
      resumable: record.resumable,
      compacting: false,
      sessionState: record.running ? 'thinking' : 'idle',
      retry: null,
      memory: record.memory,
    })
  },

  async deleteSession(id) {
    await window.api.sessions.remove(id)
    const sessions = await window.api.sessions.list().catch(() => [])
    set({ sessions })

    if (get().activeId !== id) return

    const next = sessions[0]
    if (next) await get().openSession(next.id)
    else set({ activeId: null, fold: emptyFold(), cwd: null, resumable: false, retry: null, memory: null })
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed || get().running) return

    const sessionId = await ensureSession(get, set)
    if (!sessionId) return

    // Main re-reads before the run; this is the friendly gate that keeps the
    // prompt out of the transcript when the instructions have not been trusted.
    await get().refreshMemory(sessionId)
    const memory = get().memory
    if (memory && memory.files.length > 0 && memory.trust !== 'trusted') {
      set({
        notice:
          memory.trust === 'changed'
            ? 'The project instructions changed. Review them before continuing.'
            : 'Review and trust the project instructions before running the agent.',
      })
      return
    }

    const wasResumable = get().resumable
    set({
      fold: beginTurn(get().fold, trimmed),
      running: true,
      resumable: false,
      retry: null,
      sessionState: 'thinking',
    })

    try {
      await window.api.chat.send({
        sessionId,
        text: trimmed,
        providerId: get().provider,
        model: get().model,
        mode: get().mode,
      })
      set({ notice: null })
      // Main persists the user message before it returns, so the sidebar can
      // now show the derived title instead of "New session".
      void get().refreshSessions()
    } catch (error) {
      set({
        running: false,
        sessionState: 'idle',
        resumable: wasResumable,
        notice: error instanceof Error ? error.message : String(error),
      })
      // A rejected send may have been caused by instructions changing on disk.
      void get().refreshMemory(sessionId)
    }
  },

  async abort() {
    const id = get().activeId
    if (!id) return
    set({ retry: null })
    await window.api.chat.abort(id)
  },

  async compact() {
    const id = get().activeId
    if (!id || get().running || get().compacting) return

    set({ compacting: true })
    try {
      await window.api.chat.compact({
        sessionId: id,
        providerId: get().provider,
        model: get().model,
      })
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

    if (event.type === 'retry') {
      set({
        retry: {
          errorClass: event.errorClass,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          waitMs: event.waitMs,
        },
      })
      return
    }

    // Any real output (or the end of the run) means the wait is over.
    if (get().retry) set({ retry: null })

    if (event.type === 'session_state') {
      set({ sessionState: event.state })
      return
    }

    set({ fold: reduce(get().fold, event) })

    if (event.type === 'done') {
      const unfinished =
        event.stopReason === 'cancelled' ||
        event.stopReason === 'error' ||
        event.stopReason === 'context_full'
      set({
        running: false,
        sessionState: 'idle',
        resumable: unfinished || get().resumable,
      })
      void get().refreshSessions()
    }
  },
}))

export type { AppState, Theme, View }
