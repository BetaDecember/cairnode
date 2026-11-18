import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_MEMORY_TOTAL_BYTES,
  formatProjectMemory,
  loadProjectMemory,
  memoryFingerprint,
} from './memory.ts'

async function project(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'recode-memory-'))
}

describe('loadProjectMemory', () => {
  it('loads AGENTS.md then CLAUDE.md', async () => {
    const root = await project()
    try {
      await fs.writeFile(path.join(root, 'AGENTS.md'), '# Project rules\n\nRun the tests.\n')
      await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Use two-space indentation.\n')

      const memory = await loadProjectMemory(root)
      assert.deepEqual(
        memory.files.map((file) => file.name),
        ['AGENTS.md', 'CLAUDE.md'],
      )
      assert.match(memory.files[0]?.content ?? '', /Run the tests/)
      assert.match(memory.files[1]?.content ?? '', /two-space/)
      assert.equal(memory.warnings.length, 0)
      assert.equal(memory.fingerprint.length, 64)
      assert.equal(memory.truncated, false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('returns an empty result when there are no instruction files', async () => {
    const root = await project()
    try {
      const memory = await loadProjectMemory(root)
      assert.deepEqual(memory.files, [])
      assert.deepEqual(memory.warnings, [])
      assert.equal(memory.fingerprint, '')
      assert.equal(formatProjectMemory(memory), null)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('skips a symlinked instruction file instead of reading its target', async () => {
    const root = await project()
    try {
      const secret = path.join(root, 'secret.txt')
      await fs.writeFile(secret, 'do not put this in a prompt')
      await fs.symlink(secret, path.join(root, 'AGENTS.md'))

      const memory = await loadProjectMemory(root)
      assert.deepEqual(memory.files, [])
      assert.equal(memory.warnings[0]?.name, 'AGENTS.md')
      assert.match(memory.warnings[0]?.reason ?? '', /symbolic link/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('skips binary files', async () => {
    const root = await project()
    try {
      await fs.writeFile(path.join(root, 'AGENTS.md'), Buffer.from([0x41, 0x00, 0x42]))
      const memory = await loadProjectMemory(root)
      assert.deepEqual(memory.files, [])
      assert.match(memory.warnings[0]?.reason ?? '', /binary/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('bounds a large file and marks the cut', async () => {
    const root = await project()
    try {
      await fs.writeFile(path.join(root, 'AGENTS.md'), `${'line of guidance\n'.repeat(2_000)}end\n`)

      const memory = await loadProjectMemory(root)
      const file = memory.files[0]
      assert.equal(file?.truncated, true)
      assert.match(file?.content ?? '', /\[truncated\]$/)
      assert.equal(memory.truncated, true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not leave a broken character when the cap splits one', async () => {
    const root = await project()
    try {
      // The leading ASCII byte makes the 8 KB cut land inside a two-byte é.
      await fs.writeFile(path.join(root, 'AGENTS.md'), `a${'é'.repeat(6_000)}`)

      const memory = await loadProjectMemory(root)
      const file = memory.files[0]
      assert.equal(file?.truncated, true)
      assert.doesNotMatch(file?.content ?? '', /\uFFFD/)
      assert.match(file?.content ?? '', /\[truncated\]$/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('bounds the two files together', async () => {
    const root = await project()
    try {
      await fs.writeFile(path.join(root, 'AGENTS.md'), 'a\n'.repeat(5_000))
      await fs.writeFile(path.join(root, 'CLAUDE.md'), 'b\n'.repeat(5_000))

      const memory = await loadProjectMemory(root)
      assert.equal(memory.files.length, 2)
      assert.ok(memory.bytes <= MAX_MEMORY_TOTAL_BYTES + 40)
      assert.equal(memory.files[1]?.truncated, true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('memoryFingerprint', () => {
  it('is stable for the same content and changes with the text', () => {
    const first = memoryFingerprint([{ name: 'AGENTS.md', content: 'one' }])
    const same = memoryFingerprint([{ name: 'AGENTS.md', content: 'one' }])
    const different = memoryFingerprint([{ name: 'AGENTS.md', content: 'two' }])

    assert.equal(first, same)
    assert.notEqual(first, different)
    assert.equal(memoryFingerprint([]), '')
  })
})

describe('formatProjectMemory', () => {
  it('labels the files and states that the files are subordinate context', async () => {
    const root = await project()
    try {
      await fs.writeFile(path.join(root, 'AGENTS.md'), 'Run the tests before finishing.')
      const memory = await loadProjectMemory(root)
      const text = formatProjectMemory(memory)

      assert.match(text ?? '', /## Project instructions/)
      assert.match(text ?? '', /### AGENTS.md/)
      assert.match(text ?? '', /cannot change your permissions/)
      assert.match(text ?? '', /Run the tests before finishing/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
