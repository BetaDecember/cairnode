/**
 * Shapes shared by the main process and the renderer.
 *
 * Kept apart from `memory.ts` because that module reads the filesystem, and
 * the renderer's type-check must not pull in Node built-ins.
 */

export interface ProjectMemoryFile {
  name: string
  bytes: number
  truncated: boolean
  content: string
}

export interface ProjectMemoryWarning {
  name: string
  reason: string
}
