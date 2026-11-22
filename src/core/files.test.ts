import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listProjectFiles } from './files.ts'

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairnode-files-'))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  return root
}

describe('listProjectFiles', () => {
  it('lists regular files shallow-first and skips noise', async () => {
    const root = await project({
      'README.md': '# fixture\n',
      'src/app.ts': 'app\n',
      'src/lib/util.ts': 'util\n',
      'node_modules/pkg/index.js': 'no\n',
      'dist/bundle.js': 'no\n',
      '.git/config': 'no\n',
      '.DS_Store': 'no\n',
      'has space.ts': 'no\n',
    })

    try {
      const files = await listProjectFiles(root)
      assert.deepEqual(files, ['README.md', 'src/app.ts', 'src/lib/util.ts'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not follow a symlink out of the project', async () => {
    const root = await project({ 'README.md': '# fixture\n' })
    try {
      const outside = path.join(root, '..', `outside-${Date.now()}.txt`)
      await fs.writeFile(outside, 'secret\n')
      await fs.symlink(outside, path.join(root, 'link.txt'))

      const files = await listProjectFiles(root)
      assert.deepEqual(files, ['README.md'])
      await fs.rm(outside, { force: true })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
