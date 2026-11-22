import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { DiagnosticsLog } from '../core/diagnostics.ts'
import { listProjectFiles } from '../core/files.ts'
import { SessionStore } from '../core/session.ts'
import { MAX_NUM_CTX, MIN_NUM_CTX } from '../core/settings.ts'
import { TrustStore } from '../core/trust.ts'
import { AgentHost } from './agent-host'
import { writeDiagnosticsReport } from './diagnostics'
import { readMemory } from './memory'
import { listModels, invalidateModels } from './models'
import { SettingsStore } from './settings'

/**
 * Every IPC payload is validated here, in main. The renderer is untrusted by
 * definition — a compromised renderer must not be able to reach the filesystem
 * or spawn processes just by sending a message.
 */

const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const ProviderId = z.enum(['ollama', 'openai'])
const BaseUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value.trim())
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Use an http:// or https:// URL')

const CreateInput = z.object({ cwd: z.string().min(1).max(4096).optional() }).strict()

const SessionIdInput = z.object({ id: SessionId }).strict()

const SendInput = z
  .object({
    sessionId: SessionId,
    text: z.string().min(1).max(100_000),
    mode: z.enum(['default', 'acceptEdits', 'plan', 'bypass']).optional(),
    providerId: ProviderId.optional(),
    model: z.string().min(1).max(200).optional(),
    numCtx: z.number().int().min(MIN_NUM_CTX).max(MAX_NUM_CTX).optional(),
    think: z.boolean().optional(),
  })
  .strict()

const AbortInput = z.object({ sessionId: SessionId }).strict()

const CompactInput = z
  .object({
    sessionId: SessionId,
    providerId: ProviderId.optional(),
    model: z.string().min(1).max(200).optional(),
    numCtx: z.number().int().min(MIN_NUM_CTX).max(MAX_NUM_CTX).optional(),
  })
  .strict()

const SettingsPatchInput = z
  .object({
    ollama: z
      .object({
        baseUrl: BaseUrl,
        numCtx: z.number().int().min(MIN_NUM_CTX).max(MAX_NUM_CTX),
      })
      .partial()
      .strict()
      .optional(),
    openai: z
      .object({
        enabled: z.boolean(),
        baseUrl: BaseUrl,
        models: z.array(z.string().trim().min(1).max(200)).max(50),
        numCtx: z.number().int().min(MIN_NUM_CTX).max(MAX_NUM_CTX),
        apiKey: z.string().max(4096).nullable(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()

const RespondInput = z
  .object({
    requestId: z.string().min(1).max(128),
    decision: z.enum(['allow_once', 'allow_session', 'deny']),
  })
  .strict()

const MemoryTrustInput = z
  .object({
    sessionId: SessionId,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export function registerIpc(): AgentHost {
  const store = new SessionStore(join(app.getPath('userData'), 'sessions'))
  const settings = new SettingsStore()
  const trust = new TrustStore(join(app.getPath('userData'), 'trust.json'))
  const diagnostics = new DiagnosticsLog()
  const host = new AgentHost(store, settings, trust, diagnostics)

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

  ipcMain.handle('models:list', () => listModels(settings))

  ipcMain.handle('settings:get', () => settings.read())

  ipcMain.handle('settings:save', async (_event, raw: unknown) => {
    const updated = await settings.update(SettingsPatchInput.parse(raw ?? {}))
    // A new base URL or model list must not wait for the listing cache.
    invalidateModels()
    return updated
  })

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

  ipcMain.handle('session:load', async (_event, raw: unknown) => {
    const { id } = SessionIdInput.parse(raw)
    const record = await store.load(id)
    if (!record) return null

    // The folder was approved when this session was created, so restoring it
    // re-approves the same project for new sessions and the agent's tools.
    approvedRoots.add(record.meta.cwd)

    const memory = await readMemory(record.meta.cwd, trust)

    // Return only the public shape: `history` is for the agent, not a window.
    return {
      meta: record.meta,
      messages: record.messages,
      compactions: record.compactions,
      resumable: record.resumable,
      running: host.isRunning(id),
      memory: memory.status,
    }
  })

  ipcMain.handle('session:delete', async (_event, raw: unknown) => {
    const { id } = SessionIdInput.parse(raw)
    host.abort(id)
    await store.remove(id)
  })

  ipcMain.handle('memory:status', async (_event, raw: unknown) => {
    const { id } = SessionIdInput.parse(raw)
    const record = await store.load(id)
    if (!record) throw new Error('No such session.')
    return (await readMemory(record.meta.cwd, trust)).status
  })

  ipcMain.handle('memory:trust', async (_event, raw: unknown) => {
    const input = MemoryTrustInput.parse(raw)
    const record = await store.load(input.sessionId)
    if (!record) throw new Error('No such session.')

    // The renderer supplies the fingerprint it displayed. Re-read first: if
    // the file changed between display and click, ask the user to look again
    // rather than trusting text they never saw.
    const current = await readMemory(record.meta.cwd, trust)
    if (
      current.memory.files.length === 0 ||
      current.status.fingerprint !== input.fingerprint
    ) {
      return { trusted: false, status: current.status }
    }

    await trust.trust(record.meta.cwd, input.fingerprint)
    const next = await readMemory(record.meta.cwd, trust)
    return { trusted: next.state === 'trusted', status: next.status }
  })

  ipcMain.handle('chat:send', async (_event, raw: unknown) =>
    host.send(SendInput.parse(raw)),
  )

  ipcMain.handle('chat:abort', async (_event, raw: unknown) => {
    host.abort(AbortInput.parse(raw).sessionId)
  })

  ipcMain.handle('chat:compact', async (_event, raw: unknown) =>
    host.compact(CompactInput.parse(raw)),
  )

  ipcMain.handle('permission:respond', async (_event, raw: unknown) => {
    const input = RespondInput.parse(raw)
    return host.respond(input.requestId, input.decision)
  })

  ipcMain.handle('workspace:files', async (_event, raw: unknown) => {
    const { id } = SessionIdInput.parse(raw)
    const record = await store.load(id)
    if (!record) throw new Error('No such session.')

    // Mentions are a project feature: only a folder the user opened in this
    // run can be indexed, so the list cannot roam the disk.
    if (!approvedRoots.has(record.meta.cwd)) return []

    return listProjectFiles(record.meta.cwd)
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

  ipcMain.handle('diagnostics:export', async (event) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const options = {
      title: 'Export diagnostics',
      buttonLabel: 'Export',
      defaultPath: join(app.getPath('downloads'), `cairnode-diagnostics-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    // Attach the sheet to the window that asked for it; an app-modal panel
    // would sit behind the settings dialog.
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)

    if (result.canceled || !result.filePath) return null

    await writeDiagnosticsReport({
      file: result.filePath,
      store,
      settings,
      host,
      events: diagnostics.snapshot(),
    })
    return { path: result.filePath }
  })

  return host
}
