import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  keySurvivesUpdate,
  normalizeSettings,
  originOf,
  type OllamaSettings,
  type Settings,
  type SettingsPatch,
  type StoredSettings,
} from '../core/settings.ts'

/**
 * Settings live in `settings.json` under the app-support directory.
 *
 * The API key is the only secret: it is encrypted with the OS keychain through
 * `safeStorage` and never leaves main. On the rare machine where encryption is
 * unavailable the key is kept in memory for the session instead of being
 * written in plaintext.
 */

interface FileSettings {
  ollama: OllamaSettings
  openai: StoredSettings['openai'] & {
    /** Base64 ciphertext when `keyEncrypted`, plaintext only if hand-written. */
    apiKey?: string
    keyEncrypted?: boolean
    /** Origin the key was entered for; absent on files written before binding. */
    apiKeyOrigin?: string
  }
}

export interface InternalSettings {
  ollama: OllamaSettings
  openai: StoredSettings['openai'] & { apiKey: string; apiKeyOrigin: string | null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SettingsStore {
  private readonly file: string
  private state: FileSettings | null = null
  /** Used only when the OS cannot encrypt; empty otherwise. */
  private memoryKey = ''
  /** Origin the in-memory key was entered for. */
  private memoryOrigin = ''

  constructor(file = path.join(app.getPath('userData'), 'settings.json')) {
    this.file = file
  }

  /** The renderer-facing shape: key presence, never the key. */
  async read(): Promise<Settings> {
    const internal = await this.internal()
    const { apiKey, apiKeyOrigin, ...openai } = internal.openai
    return {
      ollama: { ...internal.ollama },
      openai: {
        ...openai,
        apiKeySet: apiKey.length > 0,
        apiKeyOrigin: apiKey.length > 0 ? apiKeyOrigin : null,
      },
    }
  }

  /** Main-only shape, including the decrypted key. */
  async internal(): Promise<InternalSettings> {
    const file = await this.load()
    const key = this.readKey(file)

    return {
      ollama: { ...file.ollama },
      openai: {
        enabled: file.openai.enabled,
        baseUrl: file.openai.baseUrl,
        models: [...file.openai.models],
        numCtx: file.openai.numCtx,
        apiKey: key.value,
        apiKeyOrigin: key.origin,
      },
    }
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const current = await this.load()
    const { apiKey, ...openaiPatch } = patch.openai ?? {}

    // Re-normalize the merged result so a patch cannot write a bad URL or a
    // context window outside the supported range, even if a caller bypasses
    // the IPC schema.
    const merged = normalizeSettings({
      ollama: { ...current.ollama, ...(patch.ollama ?? {}) },
      openai: { ...current.openai, ...openaiPatch },
    })
    const nextOrigin = originOf(merged.openai.baseUrl)

    const next: FileSettings = {
      ollama: merged.ollama,
      openai: { ...merged.openai },
    }

    const hasKey = Boolean(current.openai.apiKey) || Boolean(this.memoryKey)
    const currentOrigin =
      current.openai.apiKeyOrigin ?? (this.memoryKey ? this.memoryOrigin || null : null)
    const keepExisting = keySurvivesUpdate(
      { hasKey, origin: currentOrigin, baseUrl: current.openai.baseUrl },
      merged.openai.baseUrl,
    )

    if (apiKey === null) {
      this.clearMemoryKey()
    } else if (typeof apiKey === 'string' && apiKey.trim()) {
      const key = apiKey.trim()
      if (safeStorage.isEncryptionAvailable()) {
        next.openai.apiKey = safeStorage.encryptString(key).toString('base64')
        next.openai.keyEncrypted = true
        if (nextOrigin) next.openai.apiKeyOrigin = nextOrigin
        this.clearMemoryKey()
      } else {
        delete next.openai.apiKey
        delete next.openai.keyEncrypted
        this.memoryKey = key
        this.memoryOrigin = nextOrigin ?? ''
      }
    } else if (keepExisting && current.openai.apiKey) {
      // No new key, same origin: keep the stored ciphertext.
      next.openai.apiKey = current.openai.apiKey
      if (current.openai.keyEncrypted) next.openai.keyEncrypted = true
      if (nextOrigin) next.openai.apiKeyOrigin = nextOrigin
    } else if (keepExisting && this.memoryKey) {
      this.memoryOrigin = nextOrigin ?? ''
    } else if (hasKey) {
      // The endpoint moved without a new key: drop the old secret rather than
      // forwarding it to a different host.
      this.clearMemoryKey()
    }

    this.state = next
    await this.write(next)
    return this.read()
  }

  private async load(): Promise<FileSettings> {
    if (this.state) return this.state

    let raw: unknown = null
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
    } catch {
      // A missing or malformed file means defaults; never fail app start.
      raw = null
    }

    const normalized = normalizeSettings(raw)
    const record = isRecord(raw) ? raw : {}
    const openaiRaw = isRecord(record['openai']) ? record['openai'] : {}
    let storedKey = typeof openaiRaw['apiKey'] === 'string' ? openaiRaw['apiKey'] : undefined
    const encrypted = openaiRaw['keyEncrypted'] === true
    const baseOrigin = originOf(normalized.openai.baseUrl)
    let keyOrigin =
      typeof openaiRaw['apiKeyOrigin'] === 'string' ? openaiRaw['apiKeyOrigin'] : undefined

    if (storedKey) {
      if (!keyOrigin) {
        // Files written before origin binding: trust the endpoint they were
        // saved with, so an upgrade does not force every key to be re-entered.
        keyOrigin = baseOrigin ?? undefined
      } else if (keyOrigin !== baseOrigin) {
        // A hand-edited or stale file points the key at another host.
        storedKey = undefined
        keyOrigin = undefined
        this.clearMemoryKey()
      }
    }

    this.state = {
      ollama: normalized.ollama,
      openai: {
        ...normalized.openai,
        ...(storedKey ? { apiKey: storedKey } : {}),
        ...(encrypted && storedKey ? { keyEncrypted: true } : {}),
        ...(keyOrigin && storedKey ? { apiKeyOrigin: keyOrigin } : {}),
      },
    }
    return this.state
  }

  /** Decrypt the file key, or use the in-memory fallback when it is still bound. */
  private readKey(file: FileSettings): { value: string; origin: string | null } {
    const baseOrigin = originOf(file.openai.baseUrl)

    if (file.openai.apiKey) {
      const origin = file.openai.apiKeyOrigin ?? baseOrigin
      if (!file.openai.keyEncrypted) return { value: file.openai.apiKey, origin }
      try {
        return {
          value: safeStorage.decryptString(Buffer.from(file.openai.apiKey, 'base64')),
          origin,
        }
      } catch {
        // The keychain entry changed or moved. Fall through to the memory key.
      }
    }

    if (this.memoryKey && this.memoryOrigin === baseOrigin) {
      return { value: this.memoryKey, origin: this.memoryOrigin }
    }
    return { value: '', origin: null }
  }

  private clearMemoryKey(): void {
    this.memoryKey = ''
    this.memoryOrigin = ''
  }

  private async write(next: FileSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    const body = `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`
    await fs.writeFile(temporary, body, { mode: 0o600 })
    await fs.rename(temporary, this.file)
  }
}
