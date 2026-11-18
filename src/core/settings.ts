/**
 * Provider settings shared by main and the renderer.
 *
 * The renderer sees everything here except the API key; main keeps the key and
 * reports only whether one is stored.
 */

export interface OllamaSettings {
  baseUrl: string
  /** Requested context window for Ollama runs. */
  numCtx: number
}

export interface OpenAISettings {
  enabled: boolean
  /** Base URL including the version segment, e.g. `http://127.0.0.1:1234/v1`. */
  baseUrl: string
  /** Model ids offered in the picker. */
  models: string[]
  /** Chat Completions does not report a window, so this is the effective one. */
  numCtx: number
  /** True when a key is stored. The key itself never crosses IPC. */
  apiKeySet: boolean
}

export interface Settings {
  ollama: OllamaSettings
  openai: OpenAISettings
}

export type ProviderId = 'ollama' | 'openai'

export interface StoredSettings {
  ollama: OllamaSettings
  openai: Omit<OpenAISettings, 'apiKeySet'>
}

export interface SettingsPatch {
  ollama?: Partial<Pick<OllamaSettings, 'baseUrl' | 'numCtx'>>
  openai?: Partial<Pick<OpenAISettings, 'enabled' | 'baseUrl' | 'models' | 'numCtx'>> & {
    /** A new key. `null` clears it; omitting it leaves the stored key alone. */
    apiKey?: string | null
  }
}

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
export const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:1234/v1'
export const DEFAULT_NUM_CTX = 8192
export const MIN_NUM_CTX = 2048
export const MAX_NUM_CTX = 262_144

export const DEFAULT_SETTINGS: Settings = {
  ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL, numCtx: DEFAULT_NUM_CTX },
  openai: {
    enabled: false,
    baseUrl: DEFAULT_OPENAI_BASE_URL,
    models: [],
    numCtx: DEFAULT_NUM_CTX,
    apiKeySet: false,
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `http(s)://host[:port][/path]`, with no trailing slash. */
export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return trimmed.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export function normalizeNumCtx(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(MAX_NUM_CTX, Math.max(MIN_NUM_CTX, Math.round(value)))
}

export function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!id || id.length > 200) continue
    seen.add(id)
  }
  return [...seen]
}

/**
 * Turn whatever is on disk into settings that are safe to use.
 *
 * The file is user-editable and may predate a field, so every value is checked
 * independently: one bad number must not discard the rest of the preferences.
 */
export function normalizeSettings(raw: unknown): StoredSettings {
  const record = isRecord(raw) ? raw : {}
  const ollama = isRecord(record['ollama']) ? record['ollama'] : {}
  const openai = isRecord(record['openai']) ? record['openai'] : {}

  return {
    ollama: {
      baseUrl: normalizeBaseUrl(ollama['baseUrl']) ?? DEFAULT_OLLAMA_BASE_URL,
      numCtx: normalizeNumCtx(ollama['numCtx']) ?? DEFAULT_NUM_CTX,
    },
    openai: {
      enabled: openai['enabled'] === true,
      baseUrl: normalizeBaseUrl(openai['baseUrl']) ?? DEFAULT_OPENAI_BASE_URL,
      models: normalizeModels(openai['models']),
      numCtx: normalizeNumCtx(openai['numCtx']) ?? DEFAULT_NUM_CTX,
    },
  }
}

/** The window a run will actually request, and the one the meter divides by. */
export function effectiveNumCtx(settings: Settings, providerId: string): number {
  return providerId === 'openai' ? settings.openai.numCtx : settings.ollama.numCtx
}
