import { app, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { SessionStore } from '../core/session.ts'
import { AgentHost } from './agent-host'
import { listModels } from './models'

/**
 * Every IPC payload is validated here, in main. The renderer is untrusted by
 * definition — a compromised renderer must not be able to reach the filesystem
 * or spawn processes just by sending a message.
 */

const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const CreateInput = z.object({ cwd: z.string().min(1).max(4096).optional() }).strict()

const SessionIdInput = z.object({ id: SessionId }).strict()

const SendInput = z
  .object({
    sessionId: SessionId,
    text: z.string().min(1).max(100_000),
    mode: z.enum(['default', 'acceptEdits', 'plan', 'bypass']).optional(),
    model: z.string().min(1).max(200).optional(),
    numCtx: z.number().int().min(2048).max(262_144).optional(),
    think: z.boolean().optional(),
  })
  .strict()

const AbortInput = z.object({ sessionId: SessionId }).strict()

const RespondInput = z
  .object({
    requestId: z.string().min(1).max(128),
    decision: z.enum(['allow_once', 'allow_session', 'deny']),
  })
  .strict()

export function registerIpc(): void {
  const store = new SessionStore(join(app.getPath('userData'), 'sessions'))
  const host = new AgentHost(store)

  /**
   * A session may only point at a directory the user has actually chosen.
   * Otherwise a compromised renderer could create a session rooted at `/` and
   * use the agent's tools to write anywhere on disk.
   */
  const approvedRoots = new Set<string>([app.getPath('home')])
  const cwd = process.cwd()
  if (cwd !== '/') approvedRoots.add(cwd)

  let lastCwd = cwd === '/' ? app.getPath('home') : cwd

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    isDev: !app.isPackaged,
  }))

  ipcMain.handle('models:list', () => listModels())

  ipcMain.handle('session:list', () => store.list())

  ipcMain.handle('session:create', async (_event, raw: unknown) => {
    const input = CreateInput.parse(raw ?? {})
    const root = input.cwd ?? lastCwd

    if (!approvedRoots.has(root)) {
      throw new Error('Choose the project folder with the folder picker first.')
    }

    const meta = await store.create(root)
    lastCwd = root
    return meta
  })

  ipcMain.handle('session:load', async (_event, raw: unknown) =>
    store.load(SessionIdInput.parse(raw).id),
  )

  ipcMain.handle('session:delete', async (_event, raw: unknown) => {
    const { id } = SessionIdInput.parse(raw)
    host.abort(id)
    await store.remove(id)
  })

  ipcMain.handle('chat:send', async (_event, raw: unknown) =>
    host.send(SendInput.parse(raw)),
  )

  ipcMain.handle('chat:abort', async (_event, raw: unknown) => {
    host.abort(AbortInput.parse(raw).sessionId)
  })

  ipcMain.handle('permission:respond', async (_event, raw: unknown) => {
    const input = RespondInput.parse(raw)
    return host.respond(input.requestId, input.decision)
  })

  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a project folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    })

    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null

    approvedRoots.add(picked)
    lastCwd = picked
    return picked
  })
}
