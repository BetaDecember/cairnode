import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIAGNOSTICS_LIMIT,
  DiagnosticsLog,
  buildDiagnosticsReport,
  redactPath,
  redactText,
  redactUrl,
} from './diagnostics.ts'
import type { Settings } from './settings.ts'

const HOME = '/Users/dev'

describe('redactUrl', () => {
  it('keeps the origin and path but drops credentials, query, and fragment', () => {
    assert.equal(
      redactUrl('https://user:secret@example.com:8443/v1?api_key=abc#top'),
      'https://example.com:8443/v1',
    )
  })

  it('leaves a local endpoint alone', () => {
    assert.equal(redactUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  })

  it('does not throw on a malformed value', () => {
    assert.equal(redactUrl('not a url'), 'not a url')
  })
})

describe('redactText', () => {
  it('replaces the home directory', () => {
    assert.equal(redactText(`failed in ${HOME}/project/a.ts`, HOME), 'failed in ~/project/a.ts')
  })

  it('strips tokens and URL secrets embedded in an error', () => {
    const text =
      'POST https://user:pw@example.com/v1/chat?key=abc failed: Bearer abcdef123456 sk-live_1234567890'
    assert.equal(
      redactText(text, HOME),
      'POST https://example.com/v1/chat failed: Bearer [redacted] sk-[redacted]',
    )
  })

  it('does nothing when there is nothing to redact', () => {
    assert.equal(redactText('fetch failed', HOME), 'fetch failed')
  })
})

describe('redactPath', () => {
  it('turns home into a tilde path', () => {
    assert.equal(redactPath(`${HOME}/Desktop/Client/Project`, HOME), '~/Desktop/Client/Project')
  })

  it('keeps two trailing segments for paths outside home', () => {
    assert.equal(redactPath('/Volumes/Work/Client/Project', HOME), '…/Client/Project')
  })

  it('handles the home directory itself', () => {
    assert.equal(redactPath(HOME, HOME), '~')
  })
})

describe('DiagnosticsLog', () => {
  it('keeps the newest entries within the bound', () => {
    const log = new DiagnosticsLog()
    for (let index = 0; index < DIAGNOSTICS_LIMIT + 5; index++) {
      log.record({ kind: 'done', stopReason: `stop-${index}` })
    }

    const entries = log.snapshot()
    assert.equal(entries.length, DIAGNOSTICS_LIMIT)
    assert.equal(entries[0]?.stopReason, 'stop-5')
    assert.equal(entries.at(-1)?.stopReason, `stop-${DIAGNOSTICS_LIMIT + 4}`)
  })

  it('truncates long details and returns copies', () => {
    const log = new DiagnosticsLog()
    log.record({ kind: 'error', detail: 'x'.repeat(3_000) })
    const first = log.snapshot()
    assert.equal(first[0]?.detail?.length, 2_001)
    if (first[0]) first[0].detail = 'mutated'

    assert.notEqual(log.snapshot()[0]?.detail, 'mutated')
  })
})

describe('buildDiagnosticsReport', () => {
  const settings: Settings = {
    ollama: { baseUrl: 'http://127.0.0.1:11434', numCtx: 8_192 },
    openai: {
      enabled: true,
      baseUrl: 'https://user:pw@api.example.com/v1?token=x',
      models: ['model-a'],
      numCtx: 16_384,
      apiKeySet: true,
    },
  }

  it('redacts configuration, paths, and event details', () => {
    const report = buildDiagnosticsReport({
      generatedAt: '2026-01-01T00:00:00.000Z',
      app: { version: '0.1.0', isDev: true, electron: '45', node: '24', chrome: '140' },
      machine: {
        platform: 'darwin',
        arch: 'x64',
        osType: 'Darwin',
        osRelease: '25.0.0',
        osVersion: 'macOS 26',
      },
      home: HOME,
      userData: `${HOME}/Library/Application Support/Cairnode`,
      settings,
      encryptionAvailable: true,
      sessions: [
        {
          id: 'abc123',
          cwd: `${HOME}/Desktop/Client`,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:05:00.000Z',
          resumable: true,
          running: false,
          compacting: false,
          messages: { user: 2, assistant: 1, tool: 1 },
          compactions: 0,
        },
      ],
      events: [
        {
          at: '2026-01-01T00:04:00.000Z',
          kind: 'error',
          sessionId: 'abc123',
          errorClass: 'network',
          retryable: true,
          detail: `GET https://user:pw@api.example.com/v1?key=x failed in ${HOME}/Desktop/Client`,
        },
      ],
    })

    assert.equal(report.format, 'cairnode-diagnostics')
    assert.equal(report.userData, '~/Library/Application Support/Cairnode')
    assert.equal(report.settings.openai.baseUrl, 'https://api.example.com/v1')
    assert.equal(report.settings.openai.apiKeySet, true)
    assert.equal(report.sessions.count, 1)
    assert.equal(report.sessions.items[0]?.cwd, '~/Desktop/Client')
    assert.deepEqual(report.sessions.items[0]?.messages, { user: 2, assistant: 1, tool: 1 })
    assert.equal(
      report.events[0]?.detail,
      'GET https://api.example.com/v1 failed in ~/Desktop/Client',
    )
    assert.match(report.note, /does not contain your prompts/)
  })
})
