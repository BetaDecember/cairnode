import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { builtinTools } from './builtin.ts'

const bash = builtinTools.find((tool) => tool.name === 'Bash')
if (!bash) throw new Error('Bash tool is missing')

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fs.access(file)
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`)
      await delay(25)
    }
  }
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!isGone(pid)) {
    if (Date.now() > deadline) return false
    await delay(25)
  }
  return true
}

describe('Bash tool', () => {
  it('kills the detached process group when the run is aborted', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'recode-bash-'))
    const pidFile = path.join(cwd, 'child.pid')
    const controller = new AbortController()

    try {
      const running = bash.execute(
        { command: `echo $$ > ${JSON.stringify(pidFile)}; sleep 30` },
        { cwd, signal: controller.signal },
      )

      await waitForFile(pidFile)
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
      assert.ok(Number.isInteger(pid) && pid > 0)

      controller.abort()
      const result = await running
      assert.equal(result.ok, false)
      assert.match(result.content, /Cancelled/)

      // The shell and sleep share a group; a surviving group would keep the
      // machine busy after the window is gone.
      assert.equal(await waitForExit(pid), true)
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})
