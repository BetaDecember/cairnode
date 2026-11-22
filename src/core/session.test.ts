import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionStore, endsMidTurn, titleFromText } from './session.ts'

async function store(): Promise<{ sessions: SessionStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairnode-sessions-'))
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

describe('endsMidTurn', () => {
  it('treats an empty session as settled', () => {
    assert.equal(endsMidTurn([]), false)
  })

  it('is unfinished after a user message', () => {
    assert.equal(endsMidTurn([{ role: 'user', content: 'do it' }]), true)
  })

  it('is unfinished while tool calls are unanswered', () => {
    assert.equal(
      endsMidTurn([
        { role: 'user', content: 'do it' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'a' } }],
        },
      ]),
      true,
    )
  })

  it('is unfinished after tool results, before the next reply', () => {
    assert.equal(
      endsMidTurn([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'a' } }],
        },
        { role: 'tool', toolName: 'Read', content: 'ok', ok: true },
      ]),
      true,
    )
  })

  it('is unfinished after an empty assistant turn', () => {
    assert.equal(endsMidTurn([{ role: 'assistant', content: '   ' }]), true)
  })

  it('is settled after a final assistant reply', () => {
    assert.equal(
      endsMidTurn([
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: 'Done.' },
      ]),
      false,
    )
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

  it('marks a turn with no reply as waiting', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')
    await sessions.append(id, [{ role: 'user', content: 'do it' }])

    const record = await sessions.load(id)
    assert.equal(record?.meta.preview, 'Waiting for a reply')
    assert.equal(record?.resumable, true)
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
    assert.equal(record.resumable, false)
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
    // The truncated line was the only reply, so the turn is still open.
    assert.equal(record?.resumable, true)
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
    assert.equal(record?.resumable, true)
  })

  it('does not let repair hide an unfinished raw tail', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    // Not a sequence the loop produces, but the detector must read the raw
    // tail: repair would remove the dangling call and leave a settled reply.
    await sessions.append(id, [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'Done.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'a' } }],
      },
    ])

    const record = await sessions.load(id)
    assert.equal(record?.messages.length, 2)
    assert.equal(record?.messages.at(-1)?.role, 'assistant')
    assert.equal(record?.resumable, true)
  })

  it('sees a later unfinished turn even after an earlier completed one', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    await sessions.append(id, [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'second task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'a' } }],
      },
    ])

    const record = await sessions.load(id)
    // The unfinished group is removed, leaving the user message that asked for it.
    assert.equal(record?.messages.length, 3)
    assert.equal(record?.messages.at(-1)?.role, 'user')
    assert.equal(record?.resumable, true)
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
    // The model still owes a reply, so the turn is not settled.
    assert.equal(record?.resumable, true)
  })

  it('gives the model the latest summary while keeping the transcript', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    await sessions.append(id, [
      { role: 'user', content: 'Add multiply to math.js' },
      { role: 'assistant', content: 'Done.' },
    ])
    await sessions.appendCompaction(id, {
      at: new Date().toISOString(),
      summary: 'Added multiply and ran the tests.',
      task: 'Add multiply to math.js',
      dropped: 2,
    })
    await sessions.append(id, [{ role: 'user', content: 'Now add divide' }])

    const record = await sessions.load(id)
    assert.ok(record)
    assert.equal(record.messages.length, 3)
    assert.equal(record.compactions.length, 1)
    assert.equal(record.compactions[0]?.index, 2)
    assert.equal(record.history.length, 3)
    assert.equal(record.history[0]?.synthetic, 'summary')
    assert.match(record.history[0]?.content ?? '', /Added multiply and ran the tests\./)
    assert.equal(record.history[1]?.content, 'Add multiply to math.js')
    assert.equal(record.history[2]?.content, 'Now add divide')
  })

  it('starts the model history at the most recent compaction', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')

    await sessions.append(id, [{ role: 'user', content: 'one' }])
    await sessions.appendCompaction(id, {
      at: new Date().toISOString(),
      summary: 'first',
      task: 'one',
      dropped: 1,
    })
    await sessions.append(id, [{ role: 'user', content: 'two' }])
    await sessions.appendCompaction(id, {
      at: new Date().toISOString(),
      summary: 'second',
      task: 'two',
      dropped: 3,
    })
    await sessions.append(id, [{ role: 'user', content: 'three' }])

    const record = await sessions.load(id)
    assert.equal(record?.compactions.length, 2)
    assert.equal(record?.history.length, 3)
    assert.match(record?.history[0]?.content ?? '', /^Summary of earlier work[\s\S]*second/)
    assert.equal(record?.history[1]?.content, 'two')
    assert.equal(record?.history[2]?.content, 'three')
  })

  it('returns the plain conversation when nothing was compacted', async () => {
    const { sessions } = await store()
    const { id } = await sessions.create('/tmp/project')
    await sessions.append(id, [{ role: 'user', content: 'hello' }])

    const record = await sessions.load(id)
    assert.deepEqual(record?.history, record?.messages)
    assert.deepEqual(record?.compactions, [])
  })

  it('returns no sessions for a directory that does not exist yet', async () => {
    const sessions = new SessionStore(path.join(os.tmpdir(), 'cairnode-missing-dir-xyz'))
    assert.deepEqual(await sessions.list(), [])
  })
})
