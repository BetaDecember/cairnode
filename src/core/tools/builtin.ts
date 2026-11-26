import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  messageOf,
  pathError,
  readPathError,
  readRegularFile,
  writeFileNoFollow,
  writePathError,
} from './fs-safe.ts'
import { runGrepWorker } from './grep-worker.ts'
import { displayPath, globPatternError, isWithin, resolveRealWithin, resolveWithin } from './paths.ts'
import { failure, truncate } from './types.ts'
import type { Tool, ToolResult } from './types.ts'

const MAX_GREP_FILES = 2_000
const MAX_GREP_FILE_BYTES = 400_000
const MAX_GREP_RESULTS = 200
/** Long enough for any real command; the tail is marked when this is exceeded. */
const MAX_PERMISSION_DETAIL = 8_000

/* -------------------------------------------------------------------- Read */

const read: Tool = {
  name: 'Read',
  description: 'Read a text file. Returns numbered lines.',
  risk: 'low',
  summarize(input) {
    const offset = Number(input['offset'] ?? 0)
    const limit = input['limit']
    const range = offset > 0 || limit != null ? ` @${offset}+${limit ?? '…'}` : ''
    return `${String(input['path'] ?? '?')}${range}`
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path' },
      offset: { type: 'number', description: 'First line, 0-based' },
      limit: { type: 'number', description: 'Number of lines, default 2000' },
    },
    required: ['path'],
  },
  validate: readPathError,
  async execute(input, context): Promise<ToolResult> {
    const label = String(input['path'])
    let path: string
    try {
      path = await resolveRealWithin(context.cwd, label)
    } catch (error) {
      return failure(messageOf(error))
    }

    const read = await readRegularFile(path, label)
    if (!read.ok) return failure(read.error)
    const raw = read.content

    const offset = Math.max(0, Number(input['offset'] ?? 0))
    const limit = Math.min(4000, Number(input['limit'] ?? 2000))
    const lines = raw.split('\n').slice(offset, offset + limit)

    const numbered = lines
      .map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`)
      .join('\n')

    return { ok: true, content: truncate(numbered) }
  },
}

/* ------------------------------------------------------------------- Write */

const write: Tool = {
  name: 'Write',
  description: 'Create or overwrite a file with the given content.',
  risk: 'medium',
  validate: writePathError,
  summarize(input) {
    const content = String(input['content'] ?? '')
    return `${String(input['path'] ?? '?')} (${content.split('\n').length} lines)`
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute(input, context): Promise<ToolResult> {
    const label = String(input['path'])
    let path: string
    try {
      path = await resolveRealWithin(context.cwd, label, { allowMissing: true })
    } catch (error) {
      return failure(messageOf(error))
    }

    const content = String(input['content'] ?? '')
    await fs.mkdir(dirname(path), { recursive: true })
    await writeFileNoFollow(path, content, label)
    const shown = displayPath(context.cwd, resolveWithin(context.cwd, label))

    const lines = content.split('\n')
    return {
      ok: true,
      content: `Wrote ${lines.length} lines to ${shown}.`,
      diff: {
        path: shown,
        added: lines.length,
        removed: 0,
        lines: lines.map((line) => `+${line}`),
      },
    }
  },
}

/* -------------------------------------------------------------------- Edit */

const edit: Tool = {
  name: 'Edit',
  description: 'Replace an exact string in a file. old_string must match exactly once.',
  risk: 'medium',
  validate: pathError,
  summarize(input) {
    return String(input['path'] ?? '?')
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input, context): Promise<ToolResult> {
    const label = String(input['path'])
    let path: string
    try {
      path = await resolveRealWithin(context.cwd, label)
    } catch (error) {
      return failure(messageOf(error))
    }

    const oldString = String(input['old_string'] ?? '')
    const newString = String(input['new_string'] ?? '')
    const replaceAll = input['replace_all'] === true

    if (!oldString) return failure('old_string is empty.')

    const read = await readRegularFile(path, label)
    if (!read.ok) return failure(read.error)
    const before = read.content
    const occurrences = before.split(oldString).length - 1

    if (occurrences === 0) {
      return failure(
        `No exact match for old_string in ${label}. Read the file and copy the text exactly, including indentation.`,
      )
    }
    if (occurrences > 1 && !replaceAll) {
      return failure(
        `old_string appears ${occurrences} times. Include more surrounding lines to make it unique, or set replace_all.`,
      )
    }

    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString)

    await writeFileNoFollow(path, after, label)
    const shown = displayPath(context.cwd, resolveWithin(context.cwd, label))

    return {
      ok: true,
      content: `Edited ${shown}.`,
      diff: {
        path: shown,
        added: newString.split('\n').length,
        removed: oldString.split('\n').length,
        lines: [
          ...oldString.split('\n').map((line) => `-${line}`),
          ...newString.split('\n').map((line) => `+${line}`),
        ],
      },
    }
  },
}

/* -------------------------------------------------------------------- Bash */

const bash: Tool = {
  name: 'Bash',
  description: 'Run a shell command in the project root. Returns combined stdout and stderr.',
  risk: 'high',
  summarize(input) {
    return `$ ${String(input['command'] ?? '').slice(0, 160)}`
  },
  permissionDetail(input) {
    const command = String(input['command'] ?? '')
    if (command.length <= MAX_PERMISSION_DETAIL) return command
    return `${command.slice(0, MAX_PERMISSION_DETAIL)}\n… ${command.length - MAX_PERMISSION_DETAIL} more characters not shown …`
  },
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'number', description: 'Default 120000' },
    },
    required: ['command'],
  },
  async execute(input, context): Promise<ToolResult> {
    const command = String(input['command'] ?? '').trim()
    if (!command) return failure('command is empty.')
    const timeoutMs = Math.min(600_000, Number(input['timeout_ms'] ?? 120_000))

    return await new Promise<ToolResult>((resolveResult) => {
      const child = spawn(command, {
        cwd: context.cwd,
        shell: true,
        detached: true,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
      })

      let output = ''
      let settled = false

      const finish = (result: ToolResult) => {
        if (settled) return
        settled = true
        resolveResult(result)
      }

      const killGroup = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      }

      const timer = setTimeout(() => {
        killGroup()
        finish({
          ok: false,
          content: truncate(`${output}\nCommand timed out after ${timeoutMs}ms.`),
        })
      }, timeoutMs)

      const onAbort = () => {
        killGroup()
        finish({ ok: false, content: 'Cancelled.' })
      }
      context.signal?.addEventListener('abort', onAbort, { once: true })

      const collect = (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        // Bound memory on runaway output.
        if (output.length > 400_000) output = output.slice(-200_000)
        context.onProgress?.(text)
      }

      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)

      child.on('error', (error) => {
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', onAbort)
        finish(failure(`Failed to start: ${error.message}`))
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', onAbort)
        const body = output.trim() || '(no output)'
        finish({
          ok: code === 0,
          content: truncate(
            code === 0 ? body : `${body}\n\nExit code ${code}.`,
            { headLines: 150, tailLines: 60 },
          ),
        })
      })
    })
  },
}

/* -------------------------------------------------------------------- Glob */

const glob: Tool = {
  name: 'Glob',
  description: 'List files matching a glob pattern, newest first.',
  risk: 'low',
  summarize(input) {
    return String(input['pattern'] ?? '?')
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'e.g. src/**/*.ts' },
    },
    required: ['pattern'],
  },
  validate(input) {
    return globPatternError(String(input['pattern'] ?? ''))
  },
  async execute(input, context): Promise<ToolResult> {
    const pattern = String(input['pattern'] ?? '').trim()
    if (!pattern) return failure('pattern is empty.')
    const patternError = globPatternError(pattern)
    if (patternError) return failure(patternError)

    const root = await fs.realpath(context.cwd)
    const matches: Array<{ entry: string; path: string }> = []
    for await (const entry of fs.glob(pattern, {
      cwd: context.cwd,
      exclude: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**'],
    })) {
      // A symlink inside the project can still point outside it. Resolve every
      // match and drop the ones whose real target escapes the root.
      try {
        const target = await fs.realpath(join(context.cwd, entry))
        if (!isWithin(root, target)) continue
        matches.push({ entry, path: target })
      } catch {
        continue
      }
      if (matches.length >= 500) break
    }

    if (matches.length === 0) return { ok: true, content: `No files match ${pattern}.` }

    const withStats = await Promise.all(
      matches.map(async (match) => {
        try {
          const stat = await fs.stat(match.path)
          return { entry: match.entry, mtime: stat.mtimeMs }
        } catch {
          return { entry: match.entry, mtime: 0 }
        }
      }),
    )
    withStats.sort((a, b) => b.mtime - a.mtime)

    return { ok: true, content: truncate(withStats.map((item) => item.entry).join('\n')) }
  },
}

/* -------------------------------------------------------------------- Grep */

const grep: Tool = {
  name: 'Grep',
  description: 'Search file contents with a JavaScript regular expression.',
  risk: 'low',
  summarize(input) {
    const glob = input['glob']
    return glob ? `${String(input['pattern'] ?? '?')} in ${String(glob)}` : String(input['pattern'] ?? '?')
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      glob: { type: 'string', description: 'File filter, default **/*' },
      case_sensitive: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  validate(input) {
    return globPatternError(String(input['glob'] ?? '**/*'))
  },
  async execute(input, context): Promise<ToolResult> {
    const pattern = String(input['pattern'] ?? '')
    if (!pattern) return failure('pattern is empty.')
    const fileGlob = String(input['glob'] ?? '**/*')
    const globError = globPatternError(fileGlob)
    if (globError) return failure(globError)
    const flags = input['case_sensitive'] === true ? '' : 'i'

    try {
      new RegExp(pattern, flags)
    } catch (error) {
      return failure(`Invalid regular expression: ${messageOf(error)}`)
    }

    const root = await fs.realpath(context.cwd)
    const files: string[] = []
    let scanned = 0

    for await (const entry of fs.glob(fileGlob, {
      cwd: context.cwd,
      exclude: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**'],
    })) {
      if (scanned++ >= MAX_GREP_FILES) break
      try {
        const target = await fs.realpath(join(context.cwd, entry))
        if (!isWithin(root, target)) continue
        const stat = await fs.lstat(target)
        if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES) continue
        files.push(target)
      } catch {
        // Dropped entries cannot be searched safely.
      }
    }

    if (files.length === 0) return { ok: true, content: `No matches for ${pattern}.` }

    const outcome = await runGrepWorker({
      pattern,
      flags,
      files,
      root,
      maxResults: MAX_GREP_RESULTS,
      maxFileBytes: MAX_GREP_FILE_BYTES,
    })
    if (!outcome.ok) return failure(outcome.message)
    if (outcome.matches.length === 0) return { ok: true, content: `No matches for ${pattern}.` }

    const lines = outcome.matches.map((match) => `${match.file}:${match.line}: ${match.text}`)
    return { ok: true, content: truncate(lines.join('\n')) }
  },
}

/* --------------------------------------------------------------- TodoWrite */

export interface TodoInput {
  items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }>
}

const todoWrite: Tool = {
  name: 'TodoWrite',
  description: 'Record the task plan. Call when starting or finishing a step.',
  risk: 'low',
  summarize(input) {
    const count = Array.isArray(input['items']) ? input['items'].length : 0
    return `${count} item${count === 1 ? '' : 's'}`
  },
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['items'],
  },
  async execute(input): Promise<ToolResult> {
    const items = Array.isArray(input['items']) ? input['items'] : []
    return { ok: true, content: `Plan updated (${items.length} items).` }
  },
}

export const builtinTools: Tool[] = [read, write, edit, bash, glob, grep, todoWrite]

export function toolByName(name: string): Tool | undefined {
  return builtinTools.find((tool) => tool.name === name)
}
