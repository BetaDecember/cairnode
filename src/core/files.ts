import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * A bounded index of project files for @-mentions.
 *
 * This is a convenience for pointing at a path, not a filesystem browser:
 * symlinks are skipped so a mention cannot reach outside the approved root,
 * build and dependency directories are skipped so the list stays useful, and
 * the walk stops at a fixed size. Files whose paths contain whitespace are
 * omitted because a mention is a whitespace-delimited token.
 */

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.pnpm-store',
  '.turbo',
  '.venv',
  '.yarn',
  '__pycache__',
  'build',
  'coverage',
  'DerivedData',
  'dist',
  'node_modules',
  'out',
  'Pods',
  'target',
  'vendor',
  'venv',
])

const MAX_FILES = 10_000
const MAX_DEPTH = 12

function byDepthThenName(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length
  return depth !== 0 ? depth : a.localeCompare(b)
}

export async function listProjectFiles(root: string): Promise<string[]> {
  const files: string[] = []
  // Breadth-first so a huge subtree cannot consume the cap before the files
  // at the project root are seen.
  const queue: Array<{ directory: string; relative: string; depth: number }> = [
    { directory: root, relative: '', depth: 0 },
  ]

  for (let index = 0; index < queue.length && files.length < MAX_FILES; index += 1) {
    const current = queue[index]!
    if (current.depth > MAX_DEPTH) continue

    let entries
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true })
    } catch {
      continue
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break
      if (entry.isSymbolicLink()) continue

      const relative = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push({
          directory: path.join(current.directory, entry.name),
          relative,
          depth: current.depth + 1,
        })
        continue
      }

      if (!entry.isFile()) continue
      if (entry.name === '.DS_Store') continue
      if (/\s/.test(relative)) continue
      files.push(relative)
    }
  }

  return files.sort(byDepthThenName)
}
