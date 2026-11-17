/** Show the last two segments; window chrome has no room for a full path. */
export function shortPath(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`
}
