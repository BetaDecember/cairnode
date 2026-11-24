import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolveRealWithin } from './paths.ts'
import type { ToolContext } from './types.ts'

const MAX_READ_BYTES = 1_000_000
const READ_CHUNK_BYTES = 64 * 1024

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Refuse a path before the permission card appears. The lexical check is fast;
 * the real-path check is what stops a symlink from laundering an outside target.
 */
export async function pathError(
  input: Record<string, unknown>,
  context: Pick<ToolContext, 'cwd'>,
  options: { allowMissing?: boolean } = {},
): Promise<string | null> {
  try {
    await resolveRealWithin(context.cwd, String(input['path'] ?? ''), options)
    return null
  } catch (error) {
    return messageOf(error)
  }
}

export function writePathError(
  input: Record<string, unknown>,
  context: Pick<ToolContext, 'cwd'>,
): Promise<string | null> {
  return pathError(input, context, { allowMissing: true })
}

export async function readPathError(
  input: Record<string, unknown>,
  context: Pick<ToolContext, 'cwd'>,
): Promise<string | null> {
  const invalid = await pathError(input, context)
  if (invalid) return invalid
  try {
    const target = await resolveRealWithin(context.cwd, String(input['path'] ?? ''))
    const stat = await fs.lstat(target)
    return stat.isFile() ? null : `${String(input['path'] ?? '')} is not a regular file.`
  } catch (error) {
    return messageOf(error)
  }
}

export type BoundedRead = { ok: true; content: string } | { ok: false; error: string }

/**
 * Read a regular file through a descriptor. O_NOFOLLOW refuses a last-moment
 * symlink swap and O_NONBLOCK keeps a FIFO from blocking the open; the size
 * check plus the read loop bound memory even if the file grows mid-read.
 */
export async function readRegularFile(
  path: string,
  label: string,
  maxBytes = MAX_READ_BYTES,
): Promise<BoundedRead> {
  let handle: FileHandle
  try {
    handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      return { ok: false, error: `Refusing to follow a symbolic link: ${label}` }
    }
    throw error
  }

  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { ok: false, error: `${label} is not a regular file.` }
    if (stat.size > maxBytes) {
      return { ok: false, error: `File is ${Math.round(stat.size / 1024)}KB; read a range instead.` }
    }

    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) {
        return { ok: false, error: `File grew past ${Math.round(maxBytes / 1024)}KB while reading.` }
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return { ok: true, content: Buffer.concat(chunks).toString('utf8') }
  } finally {
    await handle.close()
  }
}

export async function writeFileNoFollow(
  path: string,
  content: string,
  label: string,
): Promise<void> {
  let handle: FileHandle
  try {
    handle = await fs.open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o666,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Refusing to write through a symbolic link: ${label}`)
    }
    throw error
  }
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}
