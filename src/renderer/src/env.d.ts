import type { RecodeApi } from '../../core/api.ts'

declare global {
  interface Window {
    api: RecodeApi
  }
}

export {}
