import type { CairnodeApi } from './index'

declare global {
  interface Window {
    api: CairnodeApi
  }
}

export {}
