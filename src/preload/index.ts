import { contextBridge, ipcRenderer } from 'electron'

export interface AppInfo {
  version: string
  platform: string
  arch: string
  electron: string
  node: string
  isDev: boolean
}

/** The only surface the renderer gets. Keep this small and auditable. */
const api = {
  ping: (nonce: string): Promise<{ ok: boolean; nonce: string; now: number }> =>
    ipcRenderer.invoke('system:ping', { nonce }),

  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
}

export type RecodeApi = typeof api

contextBridge.exposeInMainWorld('api', api)
