import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { providerFor } from './providers.ts'
import type { InternalSettings } from './settings.ts'

function settings(openai: Partial<InternalSettings['openai']> = {}): InternalSettings {
  return {
    ollama: { baseUrl: 'http://127.0.0.1:11434', numCtx: 8_192 },
    openai: {
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      models: [],
      numCtx: 8_192,
      apiKey: 'nvapi-AUDIT-TEST-KEY',
      apiKeyOrigin: 'https://api.example.com',
      ...openai,
    },
  }
}

describe('providerFor key binding', () => {
  it('creates the provider when the key matches the endpoint origin', () => {
    assert.equal(providerFor(settings(), 'openai').id, 'openai')
  })

  it('refuses a key bound to another origin', () => {
    assert.throws(
      () =>
        providerFor(
          settings({
            baseUrl: 'https://attacker.example/v1',
            apiKeyOrigin: 'https://api.example.com',
          }),
          'openai',
        ),
      /bound to a different endpoint/,
    )
  })

  it('refuses plain HTTP to a remote host when a key is present', () => {
    assert.throws(
      () =>
        providerFor(
          settings({
            baseUrl: 'http://attacker.example/v1',
            apiKeyOrigin: 'http://attacker.example',
          }),
          'openai',
        ),
      /plain HTTP/,
    )
  })

  it('allows a key over loopback HTTP', () => {
    const provider = providerFor(
      settings({
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKeyOrigin: 'http://127.0.0.1:1234',
      }),
      'openai',
    )
    assert.equal(provider.id, 'openai')
  })

  it('allows a remote HTTP endpoint when no key is stored', () => {
    const provider = providerFor(
      settings({ baseUrl: 'http://attacker.example/v1', apiKey: '', apiKeyOrigin: null }),
      'openai',
    )
    assert.equal(provider.id, 'openai')
  })

  it('does not apply the OpenAI key checks to Ollama', () => {
    const provider = providerFor(
      settings({ apiKey: 'nvapi-AUDIT-TEST-KEY', apiKeyOrigin: 'https://other.example' }),
      'ollama',
    )
    assert.equal(provider.id, 'ollama')
  })
})
