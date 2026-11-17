import { isAbsolute, relative, resolve, sep } from 'node:path'

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

/** Path shown in the UI and in tool output — always project-relative. */
export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute)
  return rel === '' ? '.' : rel
}
