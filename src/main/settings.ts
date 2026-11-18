import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeSettings,
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
  }
}

export interface InternalSettings {
  ollama: OllamaSettings
  openai: StoredSettings['openai'] & { apiKey: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SettingsStore {
  private readonly file: string
  private state: FileSettings | null = null
  /** Used only when the OS cannot encrypt; empty otherwise. */
  private memoryKey = ''

  constructor(file = path.join(app.getPath('userData'), 'settings.json')) {
    this.file = file
  }

  /** The renderer-facing shape: key presence, never the key. */
  async read(): Promise<Settings> {
    const internal = await this.internal()
    const { apiKey, ...openai } = internal.openai
    return {
      ollama: { ...internal.ollama },
      openai: { ...openai, apiKeySet: apiKey.length > 0 },
    }
  }

  /** Main-only shape, including the decrypted key. */
  async internal(): Promise<InternalSettings> {
    const file = await this.load()

    return {
      ollama: { ...file.ollama },
      openai: {
        enabled: file.openai.enabled,
        baseUrl: file.openai.baseUrl,
        models: [...file.openai.models],
        numCtx: file.openai.numCtx,
        apiKey: this.decodeKey(file),
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

    const next: FileSettings = {
      ollama: merged.ollama,
      openai: { ...merged.openai },
    }

    // Keep an existing key unless the patch replaces or clears it.
    if (current.openai.apiKey) next.openai.apiKey = current.openai.apiKey
    if (current.openai.keyEncrypted) next.openai.keyEncrypted = true

    if (apiKey === null) {
      delete next.openai.apiKey
      delete next.openai.keyEncrypted
      this.memoryKey = ''
    } else if (typeof apiKey === 'string' && apiKey.trim()) {
      const key = apiKey.trim()
      if (safeStorage.isEncryptionAvailable()) {
        next.openai.apiKey = safeStorage.encryptString(key).toString('base64')
        next.openai.keyEncrypted = true
        this.memoryKey = ''
      } else {
        delete next.openai.apiKey
        delete next.openai.keyEncrypted
        this.memoryKey = key
      }
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
    const storedKey = typeof openaiRaw['apiKey'] === 'string' ? openaiRaw['apiKey'] : undefined
    const encrypted = openaiRaw['keyEncrypted'] === true

    this.state = {
      ollama: normalized.ollama,
      openai: {
        ...normalized.openai,
        ...(storedKey ? { apiKey: storedKey } : {}),
        ...(encrypted && storedKey ? { keyEncrypted: true } : {}),
      },
    }
    return this.state
  }

  private decodeKey(file: FileSettings): string {
    if (!file.openai.apiKey) return this.memoryKey
    if (!file.openai.keyEncrypted) return file.openai.apiKey

    try {
      return safeStorage.decryptString(Buffer.from(file.openai.apiKey, 'base64'))
    } catch {
      // The keychain entry changed or moved. Treat the key as missing rather
      // than failing every run.
      return this.memoryKey
    }
  }

  private async write(next: FileSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    const body = `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`
    await fs.writeFile(temporary, body, { mode: 0o600 })
    await fs.rename(temporary, this.file)
  }
}
