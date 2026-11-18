import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TrustEntry, TrustState } from './trust-types.ts'

/**
 * Per-directory trust for project instructions.
 *
 * The record stores the fingerprint of the instructions the user reviewed.
 * Editing AGENTS.md later changes the fingerprint, so the next run asks again
 * rather than silently feeding new text to the model. This is deliberately a
 * separate file from settings: it is security state, not configuration.
 */

export interface TrustFile {
  version: 1
  directories: Record<string, TrustEntry>
}

/** Keep the file small; older directories are the least likely to be used. */
export const MAX_TRUSTED_DIRECTORIES = 200

function emptyFile(): TrustFile {
  return { version: 1, directories: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function trustState(entry: TrustEntry | undefined, fingerprint: string): TrustState {
  if (!entry) return 'untrusted'
  return entry.fingerprint === fingerprint ? 'trusted' : 'changed'
}

export class TrustStore {
  private readonly file: string
  /** Serialize writes; two trust clicks must not lose one of the entries. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  /**
   * Rebuild the map field by field. A malformed file loses trust, which is
   * the safe direction: it never grants trust that was not recorded.
   */
  async read(): Promise<TrustFile> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (!isRecord(parsed) || !isRecord(parsed['directories'])) return emptyFile()

      const directories: Record<string, TrustEntry> = {}
      for (const [key, value] of Object.entries(parsed['directories'])) {
        if (!isRecord(value)) continue
        const fingerprint = value['fingerprint']
        const trustedAt = value['trustedAt']
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) continue
        if (typeof trustedAt !== 'string') continue
        directories[key] = { fingerprint, trustedAt }
      }
      return { version: 1, directories }
    } catch {
      return emptyFile()
    }
  }

  async state(cwd: string, fingerprint: string): Promise<TrustState> {
    const entries = await this.read()
    return trustState(entries.directories[path.resolve(cwd)], fingerprint)
  }

  async trust(cwd: string, fingerprint: string): Promise<void> {
    const key = path.resolve(cwd)
    await this.enqueue(async () => {
      const current = await this.read()
      current.directories[key] = { fingerprint, trustedAt: new Date().toISOString() }

      const newest = Object.entries(current.directories)
        .sort(([, a], [, b]) => b.trustedAt.localeCompare(a.trustedAt))
        .slice(0, MAX_TRUSTED_DIRECTORIES)
      const next: TrustFile = {
        version: 1,
        directories: Object.fromEntries(newest),
      }

      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporary, this.file)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    // A failed write must not poison every later trust click.
    this.queue = next.catch(() => {})
    return next
  }
}
