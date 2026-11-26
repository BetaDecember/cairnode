import { Worker } from 'node:worker_threads'

/** Whole-scan limit: a backtracking regex can hang, so the worker is killed. */
export const GREP_TIMEOUT_MS = 4_000

export interface GrepMatch {
  file: string
  line: number
  text: string
}

export type GrepOutcome = { ok: true; matches: GrepMatch[] } | { ok: false; message: string }

/**
 * The regex runs in a worker so a catastrophic backtracking pattern can be
 * killed instead of freezing the agent loop. Eval mode keeps the worker source
 * next to its caller and avoids a separate build entry.
 */
const GREP_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs/promises')
const path = require('node:path')

const { pattern, flags, files, root, maxResults, maxFileBytes } = workerData

async function run() {
  let regex
  try {
    regex = new RegExp(pattern, flags)
  } catch (error) {
    const detail = error && error.message ? error.message : String(error)
    parentPort.postMessage({ type: 'error', message: 'Invalid regular expression: ' + detail })
    return
  }

  const results = []
  for (const file of files) {
    if (results.length >= maxResults) break
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size > maxFileBytes) continue
      const content = await fs.readFile(file, 'utf8')
      if (content.includes('\\0')) continue
      const lines = content.split('\\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] || ''
        if (regex.test(line)) {
          results.push({
            file: path.relative(root, file),
            line: i + 1,
            text: line.trim().slice(0, 240),
          })
          if (results.length >= maxResults) break
        }
      }
    } catch {
      // Unreadable files are not an error for a search.
    }
  }

  parentPort.postMessage({ type: 'done', results })
}

run().catch((error) => {
  const detail = error && error.message ? error.message : String(error)
  parentPort.postMessage({ type: 'error', message: detail })
})
`

export function runGrepWorker(options: {
  pattern: string
  flags: string
  files: string[]
  root: string
  maxResults: number
  maxFileBytes: number
}): Promise<GrepOutcome> {
  return new Promise((resolve) => {
    const worker = new Worker(GREP_WORKER_SOURCE, { eval: true, workerData: options })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (outcome: GrepOutcome) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      void worker.terminate()
      resolve(outcome)
    }

    timer = setTimeout(() => {
      finish({
        ok: false,
        message: `Grep stopped after ${GREP_TIMEOUT_MS}ms. The pattern may be too expensive; narrow the glob or simplify the expression.`,
      })
    }, GREP_TIMEOUT_MS)

    worker.once('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) {
        finish({ ok: false, message: 'Grep worker returned an unexpected message.' })
        return
      }
      const record = message as Record<string, unknown>
      if (record['type'] === 'error') {
        finish({ ok: false, message: String(record['message'] ?? 'Grep failed.') })
        return
      }
      if (record['type'] === 'done') {
        const matches = Array.isArray(record['results']) ? (record['results'] as GrepMatch[]) : []
        finish({ ok: true, matches })
      }
    })

    worker.once('error', (error) => {
      finish({ ok: false, message: `Grep failed: ${error.message}` })
    })

    worker.once('exit', (code) => {
      if (!settled) finish({ ok: false, message: `Grep worker exited (${code}).` })
    })
  })
}
