import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentStreamPayload,
  ChatCompactInput,
  ChatSendInput,
  PermissionRespondInput,
  RecodeApi,
} from '../core/api'
import type { SettingsPatch } from '../core/settings'

/**
 * The only surface the renderer gets. Keep this small and auditable.
 *
 * Nothing here takes a path or a command directly — the renderer names
 * operations, and main validates and performs them.
 */
const api: RecodeApi = {
  info: () => ipcRenderer.invoke('app:info'),

  models: () => ipcRenderer.invoke('models:list'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (patch: SettingsPatch) => ipcRenderer.invoke('settings:save', patch),
  },

  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    create: (cwd?: string) => ipcRenderer.invoke('session:create', cwd ? { cwd } : {}),
    load: (id: string) => ipcRenderer.invoke('session:load', { id }),
    remove: (id: string) => ipcRenderer.invoke('session:delete', { id }),
  },

  chat: {
    send: (input: ChatSendInput) => ipcRenderer.invoke('chat:send', input),
    abort: (sessionId: string) => ipcRenderer.invoke('chat:abort', { sessionId }),
    compact: (input: ChatCompactInput) => ipcRenderer.invoke('chat:compact', input),
    respond: (input: PermissionRespondInput) => ipcRenderer.invoke('permission:respond', input),
    onEvent: (callback: (payload: AgentStreamPayload) => void) => {
      const listener = (_event: unknown, payload: AgentStreamPayload): void => callback(payload)
      ipcRenderer.on('agent:event', listener)
      return () => {
        ipcRenderer.removeListener('agent:event', listener)
      }
    },
  },

  memory: {
    status: (sessionId: string) => ipcRenderer.invoke('memory:status', { id: sessionId }),
    trust: (input: { sessionId: string; fingerprint: string }) =>
      ipcRenderer.invoke('memory:trust', input),
  },

  workspace: {
    pick: () => ipcRenderer.invoke('workspace:pick'),
  },

  diagnostics: {
    export: () => ipcRenderer.invoke('diagnostics:export'),
  },
}

contextBridge.exposeInMainWorld('api', api)
