import type { ErrorClass } from '../types.ts'

/**
 * Shared provider plumbing.
 *
 * Every adapter maps HTTP and stream failures onto the same small taxonomy so
 * the loop can decide whether a retry is worth showing, and so the UI can label
 * the failure without knowing which provider produced it.
 */

export class ProviderError extends Error {
  readonly errorClass: ErrorClass
  readonly retryable: boolean

  constructor(errorClass: ErrorClass, detail: string) {
    super(detail)
    this.name = 'ProviderError'
    this.errorClass = errorClass
    this.retryable =
      errorClass === 'rate_limit' || errorClass === 'overloaded' || errorClass === 'network'
  }
}

export function classifyStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 413) return 'context_overflow'
  if (status === 400) return 'tool_unsupported'
  if (status >= 500) return 'overloaded'
  return 'unknown'
}

/** Some models emit arguments as a JSON string rather than an object. */
export function normalizeArguments(input: unknown): unknown {
  if (typeof input !== 'string') return input ?? {}
  try {
    return JSON.parse(input)
  } catch {
    return {}
  }
}
