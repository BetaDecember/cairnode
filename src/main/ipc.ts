import { app, ipcMain } from 'electron'
import { z } from 'zod'

/**
 * Every IPC payload is validated here, in main. The renderer is untrusted by
 * definition — a compromised renderer must not be able to reach the filesystem
 * or spawn processes just by sending a message.
 */

const PingInput = z.object({ nonce: z.string().max(64) }).strict()

export function registerIpc(): void {
  ipcMain.handle('system:ping', (_event, raw: unknown) => {
    const input = PingInput.parse(raw)
    return { ok: true, nonce: input.nonce, now: Date.now() }
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    isDev: !app.isPackaged,
  }))
}
