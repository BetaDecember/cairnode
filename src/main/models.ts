import type { ModelInfo } from '../core/types.ts'
import { OllamaProvider } from '../core/provider/ollama.ts'

/**
 * Model listing with capability probes.
 *
 * The probe is expensive relative to a list call (one `/api/show` per model),
 * so the result is cached briefly. Models change rarely; a minute is plenty.
 */

const TTL_MS = 60_000

let cached: { at: number; models: ModelInfo[] } = { at: 0, models: [] }

export async function listModels(): Promise<ModelInfo[]> {
  if (Date.now() - cached.at < TTL_MS) return cached.models

  const provider = new OllamaProvider()
  const refs = await provider.listModels()

  const probed = await Promise.all(
    refs.map(async (ref): Promise<ModelInfo | null> => {
      try {
        const info = await provider.inspect(ref.id)
        return {
          id: ref.id,
          label: ref.label,
          providerId: 'ollama',
          contextWindow: info.contextWindow,
          capabilities: {
            nativeTools: info.tools,
            thinking: info.thinking,
            jsonSchema: false,
            contextWindow: info.contextWindow,
            probedAt: new Date().toISOString(),
          },
        }
      } catch {
        // A model that cannot be inspected is not selectable.
        return null
      }
    }),
  )

  cached = { at: Date.now(), models: probed.filter((model): model is ModelInfo => model !== null) }
  return cached.models
}
