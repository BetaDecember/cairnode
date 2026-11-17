import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentStreamPayload,
  ChatCompactInput,
  ChatSendInput,
  PermissionRespondInput,
  RecodeApi,
} from '../core/api'

/**
 * The only surface the renderer gets. Keep this small and auditable.
 *
 * Nothing here takes a path or a command directly — the renderer names
 * operations, and main validates and performs them.
 */
const api: RecodeApi = {
  info: () => ipcRenderer.invoke('app:info'),

  models: () => ipcRenderer.invoke('models:list'),

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

  workspace: {
    pick: () => ipcRenderer.invoke('workspace:pick'),
  },
}

contextBridge.exposeInMainWorld('api', api)
