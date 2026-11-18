import { useEffect, useState } from 'react'
import {
  MAX_NUM_CTX,
  MIN_NUM_CTX,
  type Settings,
  type SettingsPatch,
} from '@core/settings'
import { cn } from '../lib/cn'
import { useApp } from '../state/store'
import { X } from './icons'

/**
 * Provider settings.
 *
 * Edits live in local state and only reach main on Save, so a half-typed URL
 * cannot change the endpoint an active session will use. The stored API key is
 * never read back; the field is write-only and reports presence instead.
 */

const INPUT =
  'w-full rounded-control border border-line bg-canvas px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-line-strong disabled:opacity-60'

interface Draft {
  ollamaUrl: string
  ollamaCtx: string
  enabled: boolean
  openaiUrl: string
  openaiCtx: string
  models: string
  apiKey: string
}

function toDraft(settings: Settings): Draft {
  return {
    ollamaUrl: settings.ollama.baseUrl,
    ollamaCtx: String(settings.ollama.numCtx),
    enabled: settings.openai.enabled,
    openaiUrl: settings.openai.baseUrl,
    openaiCtx: String(settings.openai.numCtx),
    models: settings.openai.models.join('\n'),
    apiKey: '',
  }
}

function validWindow(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < MIN_NUM_CTX || parsed > MAX_NUM_CTX) return null
  return parsed
}

export function SettingsDialog() {
  const settings = useApp((state) => state.settings)
  const open = useApp((state) => state.settingsOpen)
  const onClose = useApp((state) => state.closeSettings)
  const onSave = useApp((state) => state.saveSettings)

  if (!open || !settings) return null
  return <Dialog settings={settings} onClose={onClose} onSave={onSave} />
}

function Dialog({
  settings,
  onClose,
  onSave,
}: {
  settings: Settings
  onClose: () => void
  onSave: (patch: SettingsPatch) => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings))
  const [clearKey, setClearKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving && !exporting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving, exporting])

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))

  const submit = async () => {
    const ollamaCtx = validWindow(draft.ollamaCtx)
    const openaiCtx = validWindow(draft.openaiCtx)

    if (ollamaCtx === null || openaiCtx === null) {
      setError(
        `Context windows must be whole numbers between ${MIN_NUM_CTX.toLocaleString()} and ${MAX_NUM_CTX.toLocaleString()} tokens.`,
      )
      return
    }

    const models = draft.models
      .split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean)

    const patch: SettingsPatch = {
      ollama: { baseUrl: draft.ollamaUrl.trim(), numCtx: ollamaCtx },
      openai: {
        enabled: draft.enabled,
        baseUrl: draft.openaiUrl.trim(),
        numCtx: openaiCtx,
        models,
        ...(clearKey
          ? { apiKey: null }
          : draft.apiKey.trim()
            ? { apiKey: draft.apiKey.trim() }
            : {}),
      },
    }

    setError(null)
    setSaving(true)
    try {
      await onSave(patch)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }

  const exportDiagnostics = async () => {
    setError(null)
    setStatus(null)
    setExporting(true)
    try {
      const result = await window.api.diagnostics.export()
      if (result) setStatus(`Saved to ${result.path}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }

  const keyStored = settings.openai.apiKeySet && !clearKey

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving && !exporting) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-[85vh] w-full max-w-[580px] flex-col overflow-hidden rounded-panel border border-line bg-panel shadow-[0_24px_70px_-20px_rgba(0,0,0,0.45)]"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h2 id="settings-title" className="text-[13.5px] font-medium text-ink">
              Settings
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              Providers, endpoints, and the window each run requests.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex size-7 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink"
          >
            <X size={15} />
          </button>
        </header>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
            <section className="space-y-3">
              <SectionHeading
                title="Ollama"
                detail="Local models over the native API."
              />
              <Field label="Base URL">
                <input
                  value={draft.ollamaUrl}
                  onChange={(event) => set({ ollamaUrl: event.target.value })}
                  placeholder="http://127.0.0.1:11434"
                  spellCheck={false}
                  autoFocus
                  className={INPUT}
                />
              </Field>
              <Field label="Context window" hint="tokens">
                <input
                  type="number"
                  min={MIN_NUM_CTX}
                  max={MAX_NUM_CTX}
                  step={1024}
                  value={draft.ollamaCtx}
                  onChange={(event) => set({ ollamaCtx: event.target.value })}
                  className={cn(INPUT, 'max-w-[160px]')}
                />
              </Field>
            </section>

            <section className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <SectionHeading
                  title="OpenAI-compatible"
                  detail="LM Studio, llama.cpp, vLLM, OpenRouter, and similar. The base URL includes /v1."
                />
                <label className="mt-0.5 flex shrink-0 cursor-pointer items-center gap-2 text-[11.5px] text-ink-muted">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => set({ enabled: event.target.checked })}
                    className="accent-clay"
                  />
                  Enabled
                </label>
              </div>

              <Field label="Base URL">
                <input
                  value={draft.openaiUrl}
                  onChange={(event) => set({ openaiUrl: event.target.value })}
                  placeholder="http://127.0.0.1:1234/v1"
                  spellCheck={false}
                  className={INPUT}
                />
              </Field>

              <Field
                label="API key"
                hint={keyStored ? 'stored in the OS keychain' : clearKey ? 'will be removed' : 'not set'}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={draft.apiKey}
                    onChange={(event) => set({ apiKey: event.target.value })}
                    placeholder={keyStored ? 'Type to replace' : 'Optional'}
                    autoComplete="off"
                    disabled={clearKey}
                    className={cn(INPUT, 'flex-1')}
                  />
                  {settings.openai.apiKeySet && (
                    <button
                      type="button"
                      onClick={() => setClearKey((current) => !current)}
                      className="shrink-0 rounded-control border border-line px-2 py-1 text-[10.5px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
                    >
                      {clearKey ? 'Keep' : 'Clear'}
                    </button>
                  )}
                </div>
              </Field>

              <Field label="Models" hint="one per line">
                <textarea
                  rows={3}
                  value={draft.models}
                  onChange={(event) => set({ models: event.target.value })}
                  placeholder={'qwen2.5-coder-32b-instruct\ngpt-4.1'}
                  spellCheck={false}
                  className={cn(INPUT, 'resize-y leading-relaxed')}
                />
              </Field>

              <Field label="Context window" hint="match the server's window">
                <input
                  type="number"
                  min={MIN_NUM_CTX}
                  max={MAX_NUM_CTX}
                  step={1024}
                  value={draft.openaiCtx}
                  onChange={(event) => set({ openaiCtx: event.target.value })}
                  className={cn(INPUT, 'max-w-[160px]')}
                />
              </Field>
            </section>
          </div>

          {error && (
            <div
              role="alert"
              className="mx-5 mb-3 rounded-control border border-danger/30 bg-danger/8 px-3 py-2 text-[11.5px] leading-relaxed text-danger"
            >
              {error}
            </div>
          )}

          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3">
            <div className="mr-auto flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void exportDiagnostics()}
                disabled={saving || exporting}
                title="Save a redacted support bundle"
                className="shrink-0 rounded-control border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
              >
                {exporting ? 'Exporting…' : 'Export diagnostics'}
              </button>
              {status && (
                <span className="max-w-[220px] truncate text-[10.5px] text-ink-faint" title={status}>
                  {status}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={saving || exporting}
              className="rounded-control border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-control bg-clay px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-[11.5px] font-semibold tracking-wide text-ink-muted uppercase">
        {title}
      </h3>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{detail}</p>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[11.5px] font-medium text-ink-muted">{label}</span>
        {hint && <span className="text-[10.5px] text-ink-faint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
