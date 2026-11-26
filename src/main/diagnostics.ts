import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import {
  buildDiagnosticsReport,
  type DiagnosticEvent,
  type DiagnosticsSessionInput,
} from '../core/diagnostics.ts'
import type { SessionStore } from '../core/session.ts'
import type { AgentHost } from './agent-host.ts'
import type { SettingsStore } from './settings.ts'

/**
 * Gather everything the report needs and write it where the user chose.
 *
 * The session files are read for counts only. Message text stays in the store;
 * the report builder never receives it.
 */
export async function writeDiagnosticsReport(options: {
  file: string
  store: SessionStore
  settings: SettingsStore
  host: AgentHost
  events: DiagnosticEvent[]
}): Promise<void> {
  const sessions: DiagnosticsSessionInput[] = []

  for (const meta of await options.store.list()) {
    const record = await options.store.load(meta.id)
    if (!record) continue

    const messages = { user: 0, assistant: 0, tool: 0 }
    for (const message of record.messages) {
      if (message.role === 'user') messages.user++
      else if (message.role === 'assistant') messages.assistant++
      else if (message.role === 'tool') messages.tool++
    }

    sessions.push({
      id: meta.id,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      resumable: record.resumable,
      running: options.host.isRunning(meta.id),
      compacting: options.host.isCompacting(meta.id),
      messages,
      compactions: record.compactions.length,
    })
  }

  const internal = await options.settings.internal()
  const report = buildDiagnosticsReport({
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      isDev: !app.isPackaged,
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      chrome: process.versions.chrome ?? '',
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      osVersion: os.version(),
    },
    home: os.homedir(),
    userData: app.getPath('userData'),
    settings: await options.settings.read(),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    secrets: internal.openai.apiKey ? [internal.openai.apiKey] : [],
    sessions,
    events: options.events,
  })

  await fs.writeFile(options.file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}
