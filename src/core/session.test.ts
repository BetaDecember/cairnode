import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionStore, titleFromText } from './session.ts'

async function store(): Promise<{ sessions: SessionStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recode-sessions-'))
  return { sessions: new SessionStore(root), root }
}

describe('titleFromText', () => {
  it('collapses whitespace and truncates', () => {
    assert.equal(titleFromText('  Add   a health\nendpoint '), 'Add a health endpoint')
    assert.equal(titleFromText('x'.repeat(100)).length, 62)
    assert.equal(titleFromText('   '), 'New session')
  })

  it('drops inline markdown markers', () => {
    assert.equal(titleFromText('Use `add` and **not** `subtract`'), 'Use add and not subtract')
  })
})

describe('SessionStore', () => {
  it('creates a session and lists it', async () => {
    const { sessions } = await store()
    const created = await sessions.create('/tmp/project')

    assert.equal(created.cwd, '/tmp/project')
    assert.equal(created.title, 'New session')
    assert.equal(created.messageCount, 0)

    const list = await sessions.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, created.id)
  })

  it('appends messages in order and derives title, preview, and timestamp', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    await sessions.append(id, [{ role: 'user', content: 'Add a /health endpoint with a test.' }])
    await sessions.append(id, [
      {
        role: 'assistant',
        content: 'I will read the routes first.',
        toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'src/api/routes.ts' } }],
      },
      { role: 'tool', toolName: 'Read', content: 'router.get(...)', ok: true },
    ])
    await sessions.append(id, [{ role: 'assistant', content: 'Added the route and a test.' }])

    const record = await sessions.load(id)
    assert.ok(record)
    assert.equal(record.messages.length, 4)
    assert.equal(record.meta.title, 'Add a /health endpoint with a test.')
    assert.equal(record.meta.preview, 'Added the route and a test.')
    assert.equal(record.meta.messageCount, 4)
    assert.ok(record.meta.updatedAt >= record.meta.createdAt)
  })

  it('keeps tool metadata that providers ignore but the transcript needs', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    await sessions.append(id, [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'Edit', input: { path: 'src/a.ts' } }],
      },
      {
        role: 'tool',
        toolName: 'Edit',
        content: 'Edited src/a.ts.',
        ok: true,
        uiDiff: { path: 'src/a.ts', added: 2, removed: 1, lines: ['-a', '+b'] },
      },
    ])

    const record = await sessions.load(id)
    const message = record?.messages[1]
    assert.equal(message?.ok, true)
    assert.equal(message?.uiDiff?.path, 'src/a.ts')
  })

  it('skips a truncated trailing line instead of failing the session', async () => {
    const { sessions, root } = await store()
    const { id } = await sessions.create('/tmp/project')
    await sessions.append(id, [{ role: 'user', content: 'hello' }])

    await fs.appendFile(path.join(root, `${id}.jsonl`), '{"type":"message","at":"x","mess', 'utf8')

    const record = await sessions.load(id)
    assert.equal(record?.messages.length, 1)
  })

  it('refuses an id that could escape the session directory', async () => {
    const { sessions } = await store()
    await assert.rejects(sessions.load('../../etc/passwd'), /Invalid session id/)
  })

  it('removes a session', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')
    await sessions.remove(id)
    assert.equal(await sessions.load(id), null)
  })

  it('drops an assistant turn whose tool calls were never answered', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    await sessions.append(id, [{ role: 'user', content: 'do it' }])
    await sessions.append(id, [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'Read', input: { path: 'a' } },
          { id: 'c2', name: 'Write', input: { path: 'b' } },
        ],
      },
      { role: 'tool', toolName: 'Read', content: 'partial', ok: true },
    ])

    const record = await sessions.load(id)
    assert.equal(record?.messages.length, 1)
    assert.equal(record?.messages[0]?.role, 'user')
  })

  it('keeps a complete tool group', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    await sessions.append(id, [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'a' } }],
      },
      { role: 'tool', toolName: 'Read', content: 'ok', ok: true },
    ])

    const record = await sessions.load(id)
    assert.equal(record?.messages.length, 3)
  })

  it('returns no sessions for a directory that does not exist yet', async () => {
    const sessions = new SessionStore(path.join(os.tmpdir(), 'recode-missing-dir-xyz'))
    assert.deepEqual(await sessions.list(), [])
  })
})
