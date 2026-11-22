import type { CairnodeApi } from '../../core/api.ts'

declare global {
  interface Window {
    api: CairnodeApi
  }
}

export {}
