import { OpenAIProvider } from '../core/provider/openai.ts'
import { OllamaProvider } from '../core/provider/ollama.ts'
import type { Provider } from '../core/provider/types.ts'
import { keyEndpointError, originOf } from '../core/settings.ts'
import type { InternalSettings } from './settings.ts'

/**
 * Turn the selected provider id into an adapter.
 *
 * Ollama is the default and needs no opt-in; the OpenAI-compatible adapter is
 * disabled until the user configures it, so a stale selection cannot silently
 * send a session somewhere else.
 */
export function providerFor(settings: InternalSettings, providerId: string): Provider {
  if (providerId === 'openai') {
    if (!settings.openai.enabled) {
      throw new Error('The OpenAI-compatible provider is disabled in Settings.')
    }
    if (settings.openai.apiKey) {
      const transport = keyEndpointError(settings.openai.baseUrl)
      if (transport) throw new Error(transport)

      const origin = originOf(settings.openai.baseUrl)
      if (!origin || settings.openai.apiKeyOrigin !== origin) {
        throw new Error(
          'The stored API key is bound to a different endpoint. Re-enter it in Settings for this base URL.',
        )
      }
    }
    return new OpenAIProvider({
      baseUrl: settings.openai.baseUrl,
      apiKey: settings.openai.apiKey,
    })
  }

  return new OllamaProvider(settings.ollama.baseUrl)
}

/** The window the run will request for this provider. */
export function numCtxFor(settings: InternalSettings, providerId: string): number {
  return providerId === 'openai' ? settings.openai.numCtx : settings.ollama.numCtx
}
