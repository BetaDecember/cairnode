/** Renderer-safe trust shapes; the store itself lives in `trust.ts`. */
export type TrustState = 'trusted' | 'untrusted' | 'changed'

export interface TrustEntry {
  fingerprint: string
  trustedAt: string
}
