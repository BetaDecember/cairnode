import fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Resolve a user-supplied path and refuse anything outside the project root. */
export function resolveWithin(cwd: string, input: string): string {
  const absolute = isAbsolute(input) ? input : resolve(cwd, input)
  const rel = relative(cwd, absolute)

  if (rel === '') return absolute
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`Path is outside the project: ${input}`)
  }
  return absolute
}

/** True when `target` is the root or a descendant of it. Both must be real paths. */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Reject glob patterns that name an absolute path or walk to a parent. */
export function globPatternError(pattern: string): string | null {
  if (isAbsolute(pattern)) {
    return `Glob patterns must be project-relative: ${pattern}`
  }
  if (pattern.split('/').includes('..')) {
    return `Glob patterns cannot contain "..": ${pattern}`
  }
  return null
}

/**
 * Resolve the real path of `input` and require it to stay inside `cwd`.
 *
 * A lexical check is not enough: a symlink inside the project can point at a
 * target outside it. `allowMissing` is for Write, where the leaf may not exist
 * yet; the nearest existing ancestor is resolved instead, so a symlinked parent
 * cannot launder a missing child into an outside write.
 */
export async function resolveRealWithin(
  cwd: string,
  input: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  const absolute = resolveWithin(cwd, input)
  const root = await fs.realpath(cwd)

  if (!options.allowMissing) {
    try {
      const target = await fs.realpath(absolute)
      requireWithin(root, target, input)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`File not found: ${input}`)
      }
      throw error
    }
  }

  let existing = absolute
  const missing: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(existing)
      const target = missing.length > 0 ? join(real, ...missing) : real
      requireWithin(root, target, input)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw new Error(`Path cannot be resolved: ${input}`)
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

function requireWithin(root: string, target: string, input: string): void {
  if (!isWithin(root, target)) {
    throw new Error(`Path is outside the project: ${input}`)
  }
}

/** Path shown in the UI and in tool output — always project-relative. */
export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute)
  return rel === '' ? '.' : rel
}
