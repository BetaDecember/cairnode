import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TrustStore, trustState } from './trust.ts'

const PRINT_A = 'a'.repeat(64)
const PRINT_B = 'b'.repeat(64)

async function temp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cairnode-trust-'))
}

describe('trustState', () => {
  it('distinguishes never trusted, trusted, and changed', () => {
    assert.equal(trustState(undefined, PRINT_A), 'untrusted')
    assert.equal(
      trustState({ fingerprint: PRINT_A, trustedAt: '2026-01-01T00:00:00.000Z' }, PRINT_A),
      'trusted',
    )
    assert.equal(
      trustState({ fingerprint: PRINT_A, trustedAt: '2026-01-01T00:00:00.000Z' }, PRINT_B),
      'changed',
    )
  })
})

describe('TrustStore', () => {
  it('records trust for the reviewed instructions only', async () => {
    const root = await temp()
    try {
      const store = new TrustStore(path.join(root, 'config', 'trust.json'))
      const project = path.join(root, 'project')
      await fs.mkdir(project)

      assert.equal(await store.state(project, PRINT_A), 'untrusted')

      await store.trust(project, PRINT_A)
      assert.equal(await store.state(project, PRINT_A), 'trusted')
      assert.equal(await store.state(project, PRINT_B), 'changed')

      const parsed = await store.read()
      assert.equal(parsed.directories[path.resolve(project)]?.fingerprint, PRINT_A)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes the directory path', async () => {
    const root = await temp()
    try {
      const store = new TrustStore(path.join(root, 'trust.json'))
      const project = path.join(root, 'project')
      await fs.mkdir(project)

      await store.trust(`${project}/`, PRINT_A)
      assert.equal(await store.state(project, PRINT_A), 'trusted')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('writes a private file and keeps concurrent entries', async () => {
    const root = await temp()
    try {
      const file = path.join(root, 'config', 'trust.json')
      const store = new TrustStore(file)
      const first = path.join(root, 'first')
      const second = path.join(root, 'second')
      await fs.mkdir(first)
      await fs.mkdir(second)

      await Promise.all([store.trust(first, PRINT_A), store.trust(second, PRINT_B)])

      const parsed = await store.read()
      assert.equal(parsed.directories[path.resolve(first)]?.fingerprint, PRINT_A)
      assert.equal(parsed.directories[path.resolve(second)]?.fingerprint, PRINT_B)

      const info = await fs.stat(file)
      assert.equal(info.mode & 0o777, 0o600)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('treats a malformed file as no trust at all', async () => {
    const root = await temp()
    try {
      const file = path.join(root, 'trust.json')
      const store = new TrustStore(file)
      const project = path.join(root, 'project')
      await fs.mkdir(project)
      await fs.writeFile(file, '{ not json')

      assert.equal(await store.state(project, PRINT_A), 'untrusted')

      await store.trust(project, PRINT_B)
      assert.equal(await store.state(project, PRINT_B), 'trusted')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
