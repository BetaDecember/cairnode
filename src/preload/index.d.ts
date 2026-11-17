import type { RecodeApi } from './index'

declare global {
  interface Window {
    api: RecodeApi
  }
}

export {}
