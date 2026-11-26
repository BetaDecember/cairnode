import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NUM_CTX,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_SETTINGS,
  effectiveNumCtx,
  isLoopbackHost,
  keyEndpointError,
  keySurvivesUpdate,
  normalizeBaseUrl,
  normalizeModels,
  normalizeNumCtx,
  normalizeSettings,
  originOf,
} from './settings.ts'

describe('settings', () => {
  it('falls back to defaults for a missing or malformed file', () => {
    const expected = {
      ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL, numCtx: DEFAULT_NUM_CTX },
      openai: {
        enabled: false,
        baseUrl: DEFAULT_OPENAI_BASE_URL,
        models: [],
        numCtx: DEFAULT_NUM_CTX,
      },
    }

    assert.deepEqual(normalizeSettings(null), expected)
    assert.deepEqual(normalizeSettings('nope'), expected)
    assert.deepEqual(normalizeSettings({ ollama: 3, openai: [] }), expected)
  })

  it('keeps valid values and fills the gaps independently', () => {
    const normalized = normalizeSettings({
      ollama: { baseUrl: 'http://192.168.1.8:11434/', numCtx: 16384 },
      openai: { enabled: true, baseUrl: 'https://api.example.com/v1', models: ['gpt-4.1'], numCtx: 'big' },
    })

    assert.equal(normalized.ollama.baseUrl, 'http://192.168.1.8:11434')
    assert.equal(normalized.ollama.numCtx, 16384)
    assert.equal(normalized.openai.enabled, true)
    assert.equal(normalized.openai.baseUrl, 'https://api.example.com/v1')
    assert.deepEqual(normalized.openai.models, ['gpt-4.1'])
    assert.equal(normalized.openai.numCtx, DEFAULT_NUM_CTX)
  })

  it('ignores non-http base URLs', () => {
    assert.equal(normalizeBaseUrl('ftp://127.0.0.1'), null)
    assert.equal(normalizeBaseUrl('file:///etc/passwd'), null)
    assert.equal(normalizeBaseUrl('not a url'), null)
    assert.equal(normalizeBaseUrl(' http://localhost:1234/v1/// '), 'http://localhost:1234/v1')
  })

  it('clamps the context window to the supported range', () => {
    assert.equal(normalizeNumCtx(8192), 8192)
    assert.equal(normalizeNumCtx(100), 2048)
    assert.equal(normalizeNumCtx(10_000_000), 262_144)
    assert.equal(normalizeNumCtx(8192.4), 8192)
    assert.equal(normalizeNumCtx(Number.NaN), null)
    assert.equal(normalizeNumCtx('8192'), null)
  })

  it('deduplicates model ids and drops empty entries', () => {
    assert.deepEqual(normalizeModels(['a', 'a', ' b ', '', 3, null, 'a']), ['a', 'b'])
    assert.deepEqual(normalizeModels('a'), [])
  })

  it('reads the window for the selected provider', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL, numCtx: 4096 },
      openai: { ...DEFAULT_SETTINGS.openai, numCtx: 32_768 },
    }

    assert.equal(effectiveNumCtx(settings, 'ollama'), 4096)
    assert.equal(effectiveNumCtx(settings, 'openai'), 32_768)
    assert.equal(effectiveNumCtx(settings, 'something-else'), 4096)
  })
})

describe('key origin binding', () => {
  it('uses scheme, host, and port as the origin', () => {
    assert.equal(originOf('https://api.example.com/v1'), 'https://api.example.com')
    assert.equal(originOf('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234')
    assert.equal(originOf('not a url'), null)
  })

  it('recognizes loopback hosts', () => {
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('api.localhost'), true)
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('127.10.20.30'), true)
    assert.equal(isLoopbackHost('[::1]'), true)
    assert.equal(isLoopbackHost('192.168.1.10'), false)
  })

  it('does not mistake a hostname that starts with 127 for a loopback literal', () => {
    assert.equal(isLoopbackHost('127.0.0.1.evil.com'), false)
    assert.equal(isLoopbackHost('127.0.0.999'), false)
    assert.equal(isLoopbackHost('128.0.0.1'), false)
  })

  it('refuses plain HTTP to a remote host when a key is present', () => {
    assert.match(String(keyEndpointError('http://api.example.com/v1')), /plain HTTP/)
    assert.match(String(keyEndpointError('http://127.0.0.1.evil.com/v1')), /plain HTTP/)
    assert.equal(keyEndpointError('https://api.example.com/v1'), null)
    assert.equal(keyEndpointError('http://127.0.0.1:1234/v1'), null)
    assert.equal(keyEndpointError('http://localhost:1234/v1'), null)
  })

  it('keeps a key only when the endpoint origin is unchanged', () => {
    const current = {
      hasKey: true,
      origin: 'https://api.example.com',
      baseUrl: 'https://api.example.com/v1',
    }

    assert.equal(keySurvivesUpdate(current, 'https://api.example.com/v2'), true)
    assert.equal(keySurvivesUpdate(current, 'https://attacker.example/v1'), false)
    assert.equal(keySurvivesUpdate(current, 'http://api.example.com/v1'), false)
    assert.equal(keySurvivesUpdate({ ...current, hasKey: false }, current.baseUrl), false)
  })

  it('treats a legacy key without origin metadata as bound to its saved endpoint', () => {
    const legacy = { hasKey: true, origin: null, baseUrl: 'https://api.example.com/v1' }

    assert.equal(keySurvivesUpdate(legacy, 'https://api.example.com/v2'), true)
    assert.equal(keySurvivesUpdate(legacy, 'https://attacker.example/v1'), false)
  })
})
