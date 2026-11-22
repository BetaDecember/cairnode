import type { Settings } from './settings.ts'

/**
 * The redacted support bundle.
 *
 * With zero telemetry this file is the only way a user can show what went
 * wrong. It has to be useful without carrying prompts, replies, tool output,
 * or secrets: support gets configuration, counts, and lifecycle events, never
 * conversation text. Redaction lives here so it can be tested without
 * Electron.
 */

export const DIAGNOSTICS_LIMIT = 200
const MAX_DETAIL_LENGTH = 2_000

export type DiagnosticEventKind =
  | 'error'
  | 'done'
  | 'send_failed'
  | 'compaction_failed'
  | 'abort_all'

export interface DiagnosticEvent {
  at: string
  kind: DiagnosticEventKind
  sessionId?: string
  errorClass?: string
  retryable?: boolean
  stopReason?: string
  reason?: string
  detail?: string
}

export type DiagnosticEventInput = Omit<DiagnosticEvent, 'at'> & { at?: string }

/** A bounded ring: diagnostics must not become an unbounded log of the app. */
export class DiagnosticsLog {
  private entries: DiagnosticEvent[] = []

  record(event: DiagnosticEventInput): void {
    const { at = new Date().toISOString(), ...rest } = event
    const detail =
      rest.detail && rest.detail.length > MAX_DETAIL_LENGTH
        ? `${rest.detail.slice(0, MAX_DETAIL_LENGTH)}…`
        : rest.detail
    this.entries.push({ at, ...rest, ...(detail ? { detail } : {}) })
    if (this.entries.length > DIAGNOSTICS_LIMIT) {
      this.entries.splice(0, this.entries.length - DIAGNOSTICS_LIMIT)
    }
  }

  snapshot(): DiagnosticEvent[] {
    return this.entries.map((entry) => ({ ...entry }))
  }
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/g
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}/g

/** Keep the origin and path; drop credentials, query strings, and fragments. */
function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return value
  }
}

export function redactUrl(value: string): string {
  return redactText(safeUrl(value), '')
}

/**
 * Replace the home directory, URL secrets, bearer tokens, and obvious API keys
 * anywhere in free-form text. Error details are the only place such text
 * appears in the report.
 */
export function redactText(text: string, home: string): string {
  let next = text

  const normalizedHome = home.replace(/\/+$/, '')
  if (normalizedHome) next = next.split(normalizedHome).join('~')

  next = next.replace(URL_PATTERN, (match) => {
    const trailing = /[.,;:)\]]+$/.exec(match)?.[0] ?? ''
    const url = trailing ? match.slice(0, -trailing.length) : match
    return `${safeUrl(url)}${trailing}`
  })
  next = next.replace(BEARER_PATTERN, 'Bearer [redacted]')
  next = next.replace(API_KEY_PATTERN, 'sk-[redacted]')
  return next
}

/**
 * Show where a project sits without shipping the whole path. Paths under home
 * keep their relative structure; external paths keep two trailing segments.
 */
export function redactPath(value: string, home: string): string {
  const clean = value.replace(/\/+$/, '')
  if (!clean) return value

  const normalizedHome = home.replace(/\/+$/, '')
  if (normalizedHome && clean === normalizedHome) return '~'
  if (normalizedHome && clean.startsWith(`${normalizedHome}/`)) {
    return `~${clean.slice(normalizedHome.length)}`
  }

  if (clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean)) {
    const parts = clean.split(/[\\/]+/).filter(Boolean)
    return `…/${parts.slice(-2).join('/')}`
  }
  return clean
}

export interface DiagnosticsAppInfo {
  version: string
  isDev: boolean
  electron: string
  node: string
  chrome: string
}

export interface DiagnosticsMachineInfo {
  platform: string
  arch: string
  osType: string
  osRelease: string
  osVersion: string
}

export interface DiagnosticsSessionInput {
  id: string
  cwd: string
  createdAt: string
  updatedAt: string
  resumable: boolean
  running: boolean
  compacting: boolean
  messages: { user: number; assistant: number; tool: number }
  compactions: number
}

export interface DiagnosticsSessionSummary extends DiagnosticsSessionInput {
  /** Redacted relative to home where possible. */
  cwd: string
}

export interface DiagnosticsReport {
  format: 'cairnode-diagnostics'
  formatVersion: 1
  generatedAt: string
  note: string
  app: DiagnosticsAppInfo
  machine: DiagnosticsMachineInfo
  userData: string
  settings: {
    ollama: { baseUrl: string; numCtx: number }
    openai: {
      enabled: boolean
      baseUrl: string
      models: string[]
      numCtx: number
      apiKeySet: boolean
    }
    /** Whether the stored key can be encrypted at rest on this machine. */
    encryptionAvailable: boolean
  }
  sessions: { count: number; items: DiagnosticsSessionSummary[] }
  events: DiagnosticEvent[]
}

export interface DiagnosticsInput {
  generatedAt: string
  app: DiagnosticsAppInfo
  machine: DiagnosticsMachineInfo
  home: string
  userData: string
  settings: Settings
  encryptionAvailable: boolean
  sessions: DiagnosticsSessionInput[]
  events: DiagnosticEvent[]
}

const NOTE =
  'No telemetry. This file was produced on request. It contains app and machine versions, redacted endpoint configuration, per-session message counts, and recent run lifecycle events. It does not contain your prompts, tool output, or API keys; error messages may mention endpoints and short provider responses. Base URL credentials, query strings, and fragments are removed; project paths are shortened.'

export function buildDiagnosticsReport(input: DiagnosticsInput): DiagnosticsReport {
  return {
    format: 'cairnode-diagnostics',
    formatVersion: 1,
    generatedAt: input.generatedAt,
    note: NOTE,
    app: { ...input.app },
    machine: { ...input.machine },
    userData: redactPath(input.userData, input.home),
    settings: {
      ollama: {
        baseUrl: redactUrl(input.settings.ollama.baseUrl),
        numCtx: input.settings.ollama.numCtx,
      },
      openai: {
        enabled: input.settings.openai.enabled,
        baseUrl: redactUrl(input.settings.openai.baseUrl),
        models: [...input.settings.openai.models],
        numCtx: input.settings.openai.numCtx,
        apiKeySet: input.settings.openai.apiKeySet,
      },
      encryptionAvailable: input.encryptionAvailable,
    },
    sessions: {
      count: input.sessions.length,
      items: input.sessions.map((session) => ({
        ...session,
        cwd: redactPath(session.cwd, input.home),
        messages: { ...session.messages },
      })),
    },
    events: input.events.map((event) => ({
      ...event,
      ...(event.detail ? { detail: redactText(event.detail, input.home) } : {}),
    })),
  }
}
