import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { displayPath, resolveWithin } from './paths.ts'
import { failure, truncate } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const MAX_READ_BYTES = 1_000_000
const MAX_GREP_FILES = 2_000

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
  async execute(input, context): Promise<ToolResult> {
    const path = resolveWithin(context.cwd, String(input['path']))
    const stat = await fs.stat(path)
    if (stat.isDirectory()) return failure(`${input['path']} is a directory.`)
    if (stat.size > MAX_READ_BYTES) {
      return failure(`File is ${Math.round(stat.size / 1024)}KB; read a range instead.`)
    }

    const raw = await fs.readFile(path, 'utf8')
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
    const path = resolveWithin(context.cwd, String(input['path']))
    const content = String(input['content'] ?? '')
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, content, 'utf8')

    const lines = content.split('\n')
    return {
      ok: true,
      content: `Wrote ${lines.length} lines to ${displayPath(context.cwd, path)}.`,
      diff: {
        path: displayPath(context.cwd, path),
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
    const path = resolveWithin(context.cwd, String(input['path']))
    const oldString = String(input['old_string'] ?? '')
    const newString = String(input['new_string'] ?? '')
    const replaceAll = input['replace_all'] === true

    if (!oldString) return failure('old_string is empty.')

    const before = await fs.readFile(path, 'utf8')
    const occurrences = before.split(oldString).length - 1

    if (occurrences === 0) {
      return failure(
        `No exact match for old_string in ${displayPath(context.cwd, path)}. Read the file and copy the text exactly, including indentation.`,
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

    await fs.writeFile(path, after, 'utf8')

    return {
      ok: true,
      content: `Edited ${displayPath(context.cwd, path)}.`,
      diff: {
        path: displayPath(context.cwd, path),
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
  async execute(input, context): Promise<ToolResult> {
    const pattern = String(input['pattern'] ?? '').trim()
    if (!pattern) return failure('pattern is empty.')

    const matches: string[] = []
    for await (const entry of fs.glob(pattern, {
      cwd: context.cwd,
      exclude: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**'],
    })) {
      matches.push(entry)
      if (matches.length >= 500) break
    }

    if (matches.length === 0) return { ok: true, content: `No files match ${pattern}.` }

    const withStats = await Promise.all(
      matches.map(async (entry) => {
        try {
          const stat = await fs.stat(`${context.cwd}/${entry}`)
          return { entry, mtime: stat.mtimeMs }
        } catch {
          return { entry, mtime: 0 }
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
  async execute(input, context): Promise<ToolResult> {
    const pattern = String(input['pattern'] ?? '')
    if (!pattern) return failure('pattern is empty.')
    const fileGlob = String(input['glob'] ?? '**/*')
    const flags = input['case_sensitive'] === true ? '' : 'i'

    let regex: RegExp
    try {
      regex = new RegExp(pattern, flags)
    } catch (error) {
      return failure(`Invalid regular expression: ${(error as Error).message}`)
    }

    const results: string[] = []
    let scanned = 0

    for await (const entry of fs.glob(fileGlob, {
      cwd: context.cwd,
      exclude: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**'],
    })) {
      if (scanned++ >= MAX_GREP_FILES) break
      if (results.length >= 200) break

      const absolute = `${context.cwd}/${entry}`
      try {
        const stat = await fs.stat(absolute)
        if (!stat.isFile() || stat.size > 400_000) continue
        const content = await fs.readFile(absolute, 'utf8')
        if (content.includes('\0')) continue

        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? ''
          if (regex.test(line)) {
            results.push(`${entry}:${i + 1}: ${line.trim().slice(0, 240)}`)
            if (results.length >= 200) break
          }
        }
      } catch {
        // Unreadable files are not an error for a search.
      }
    }

    if (results.length === 0) return { ok: true, content: `No matches for ${pattern}.` }
    return { ok: true, content: truncate(results.join('\n')) }
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
