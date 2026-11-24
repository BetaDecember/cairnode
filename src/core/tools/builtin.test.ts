import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { builtinTools } from './builtin.ts'
import type { Tool } from './types.ts'

function tool(name: string): Tool {
  const found = builtinTools.find((entry) => entry.name === name)
  if (!found) throw new Error(`${name} tool is missing`)
  return found
}

const read = tool('Read')
const write = tool('Write')
const edit = tool('Edit')
const glob = tool('Glob')
const grep = tool('Grep')

interface Workspace {
  base: string
  project: string
  outside: string
}

async function workspace(): Promise<Workspace> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cairnode-tools-'))
  const project = path.join(base, 'project')
  const outside = path.join(base, 'outside')
  await fs.mkdir(project)
  await fs.mkdir(outside)
  return { base, project, outside }
}

async function cleanup(base: string): Promise<void> {
  await fs.rm(base, { recursive: true, force: true })
}

describe('Read tool containment', () => {
  it('refuses a symlink that points outside the project', async () => {
    const { base, project, outside } = await workspace()
    try {
      const secret = path.join(outside, 'secret.txt')
      await fs.writeFile(secret, 'AUDIT-SECRET-9f3c1d\n')
      await fs.symlink(secret, path.join(project, 'link.txt'))

      const invalid = await read.validate?.({ path: 'link.txt' }, { cwd: project })
      assert.match(String(invalid), /outside the project/)

      const result = await read.execute({ path: 'link.txt' }, { cwd: project })
      assert.equal(result.ok, false)
      assert.match(result.content, /outside the project/)
      assert.doesNotMatch(result.content, /AUDIT-SECRET/)
    } finally {
      await cleanup(base)
    }
  })

  it('still follows a symlink whose real target is inside the project', async () => {
    const { base, project } = await workspace()
    try {
      const target = path.join(project, 'real.txt')
      await fs.writeFile(target, 'inside\n')
      await fs.symlink(target, path.join(project, 'alias.txt'))

      const result = await read.execute({ path: 'alias.txt' }, { cwd: project })
      assert.equal(result.ok, true)
      assert.match(result.content, /inside/)
    } finally {
      await cleanup(base)
    }
  })

  it('refuses an absolute path outside the project', async () => {
    const { base, project, outside } = await workspace()
    try {
      const secret = path.join(outside, 'secret.txt')
      await fs.writeFile(secret, 'AUDIT-SECRET-9f3c1d\n')

      const result = await read.execute({ path: secret }, { cwd: project })
      assert.equal(result.ok, false)
      assert.match(result.content, /outside the project/)
    } finally {
      await cleanup(base)
    }
  })

  it('rejects a FIFO without blocking', async () => {
    const { base, project } = await workspace()
    try {
      execFileSync('mkfifo', [path.join(project, 'pipe')])
      const started = Date.now()
      const result = await read.execute({ path: 'pipe' }, { cwd: project })
      assert.equal(result.ok, false)
      assert.match(result.content, /not a regular file/)
      assert.ok(Date.now() - started < 3_000, 'the read did not block on the FIFO')
    } finally {
      await cleanup(base)
    }
  })

  it('rejects a symlink to a device file', async () => {
    const { base, project } = await workspace()
    try {
      await fs.symlink('/dev/zero', path.join(project, 'zero'))
      const started = Date.now()
      const result = await read.execute({ path: 'zero' }, { cwd: project })
      assert.equal(result.ok, false)
      assert.match(result.content, /outside the project/)
      assert.ok(Date.now() - started < 3_000, 'the read did not touch the device')
    } finally {
      await cleanup(base)
    }
  })
})

describe('Write and Edit containment', () => {
  it('refuses to overwrite an outside file through a symlink', async () => {
    const { base, project, outside } = await workspace()
    try {
      const target = path.join(outside, 'target.txt')
      await fs.writeFile(target, 'ORIGINAL\n')
      await fs.symlink(target, path.join(project, 'link.txt'))

      const result = await write.execute({ path: 'link.txt', content: 'PWNED\n' }, { cwd: project })
      assert.equal(result.ok, false)
      assert.match(result.content, /outside the project/)
      assert.equal(await fs.readFile(target, 'utf8'), 'ORIGINAL\n')
    } finally {
      await cleanup(base)
    }
  })

  it('refuses a missing child under a symlinked parent', async () => {
    const { base, project, outside } = await workspace()
    try {
      await fs.symlink(outside, path.join(project, 'linkdir'))

      const result = await write.execute(
        { path: 'linkdir/pwn.txt', content: 'PWNED\n' },
        { cwd: project },
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /outside the project/)
      await assert.rejects(fs.stat(path.join(outside, 'pwn.txt')))
    } finally {
      await cleanup(base)
    }
  })

  it('refuses to edit an outside file through a symlink', async () => {
    const { base, project, outside } = await workspace()
    try {
      const target = path.join(outside, 'target.txt')
      await fs.writeFile(target, 'EDIT-ME-12345\n')
      await fs.symlink(target, path.join(project, 'link.txt'))

      const result = await edit.execute(
        { path: 'link.txt', old_string: 'EDIT-ME-12345', new_string: 'EDITED-OUTSIDE' },
        { cwd: project },
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /outside the project/)
      assert.equal(await fs.readFile(target, 'utf8'), 'EDIT-ME-12345\n')
    } finally {
      await cleanup(base)
    }
  })
})

describe('Glob and Grep containment', () => {
  it('rejects parent and absolute glob patterns', async () => {
    const { base, project, outside } = await workspace()
    try {
      for (const pattern of ['../outside/**', path.join(outside, '**/*')]) {
        const result = await glob.execute({ pattern }, { cwd: project })
        assert.equal(result.ok, false)
      }

      const invalid = await glob.validate?.({ pattern: '../outside/**' }, { cwd: project })
      assert.match(String(invalid), /cannot contain/)
    } finally {
      await cleanup(base)
    }
  })

  it('omits a symlink whose real target is outside the project', async () => {
    const { base, project, outside } = await workspace()
    try {
      await fs.writeFile(path.join(project, 'ok.txt'), 'ok\n')
      await fs.writeFile(path.join(outside, 'secret.txt'), 'hidden\n')
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'leak.txt'))

      const result = await glob.execute({ pattern: '**/*.txt' }, { cwd: project })
      assert.equal(result.ok, true)
      assert.match(result.content, /ok\.txt/)
      assert.doesNotMatch(result.content, /leak\.txt/)
    } finally {
      await cleanup(base)
    }
  })

  it('rejects parent globs and never searches through an outside symlink', async () => {
    const { base, project, outside } = await workspace()
    try {
      await fs.writeFile(path.join(project, 'inside.txt'), 'nothing here\n')
      await fs.writeFile(path.join(outside, 'secret.txt'), 'AUDIT-SECRET-9f3c1d\n')
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'leak.txt'))

      const rejected = await grep.execute(
        { pattern: 'AUDIT-SECRET', glob: '../outside/**' },
        { cwd: project },
      )
      assert.equal(rejected.ok, false)
      assert.match(rejected.content, /cannot contain/)

      const result = await grep.execute({ pattern: 'AUDIT-SECRET' }, { cwd: project })
      assert.equal(result.ok, true)
      assert.match(result.content, /No matches/)
      assert.doesNotMatch(result.content, /AUDIT-SECRET-9f3c1d/)
    } finally {
      await cleanup(base)
    }
  })
})

describe('file tools still work inside the project', () => {
  it('reads, writes, edits, globs, and greps inside the root', async () => {
    const { base, project } = await workspace()
    try {
      const written = await write.execute(
        { path: 'src/note.txt', content: 'hello\nworld\n' },
        { cwd: project },
      )
      assert.equal(written.ok, true)

      const readBack = await read.execute({ path: 'src/note.txt' }, { cwd: project })
      assert.equal(readBack.ok, true)
      assert.match(readBack.content, /hello/)
      assert.match(readBack.content, /world/)

      const edited = await edit.execute(
        { path: 'src/note.txt', old_string: 'world', new_string: 'there' },
        { cwd: project },
      )
      assert.equal(edited.ok, true)

      const listed = await glob.execute({ pattern: '**/*.txt' }, { cwd: project })
      assert.equal(listed.ok, true)
      assert.match(listed.content, /src\/note\.txt/)

      const found = await grep.execute({ pattern: 'there' }, { cwd: project })
      assert.equal(found.ok, true)
      assert.match(found.content, /src\/note\.txt:2: there/)
    } finally {
      await cleanup(base)
    }
  })

  it('stops a catastrophic regular expression instead of hanging', { timeout: 20_000 }, async () => {
    const { base, project } = await workspace()
    try {
      await fs.writeFile(path.join(project, 'hang.txt'), `${'a'.repeat(30_000)}!\n`)

      const started = Date.now()
      const result = await grep.execute({ pattern: '(a+)+$' }, { cwd: project })
      const elapsed = Date.now() - started

      assert.equal(result.ok, false)
      assert.match(result.content, /stopped after/)
      assert.ok(elapsed < 15_000, `the scan was bounded (took ${elapsed}ms)`)
    } finally {
      await cleanup(base)
    }
  })
})
