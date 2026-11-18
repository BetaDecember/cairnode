import type { ModelInfo } from '../core/types.ts'
import { OllamaProvider } from '../core/provider/ollama.ts'
import type { InternalSettings } from './settings.ts'
import type { SettingsStore } from './settings.ts'

/**
 * Model listing across the enabled providers.
 *
 * Probing every Ollama model is expensive relative to a list call (one
 * `/api/show` each), so results are cached briefly. Settings changes call
 * `invalidateModels()` so a new base URL or model list shows up immediately.
 */

const TTL_MS = 60_000

let cached: { at: number; models: ModelInfo[] } = { at: 0, models: [] }

export function invalidateModels(): void {
  cached = { at: 0, models: [] }
}

export async function listModels(store: SettingsStore, force = false): Promise<ModelInfo[]> {
  if (!force && Date.now() - cached.at < TTL_MS) return cached.models

  const settings = await store.internal()
  const [ollama, openai] = await Promise.all([ollamaModels(settings), openaiModels(settings)])

  cached = { at: Date.now(), models: [...ollama, ...openai] }
  return cached.models
}

async function ollamaModels(settings: InternalSettings): Promise<ModelInfo[]> {
  const provider = new OllamaProvider(settings.ollama.baseUrl)

  let refs
  try {
    refs = await provider.listModels()
  } catch {
    // Ollama may simply not be running; that must not hide other providers.
    return []
  }

  const probed = await Promise.all(
    refs.map(async (ref): Promise<ModelInfo | null> => {
      try {
        const info = await provider.inspect(ref.id)
        return {
          id: ref.id,
          label: ref.label,
          providerId: 'ollama',
          // The picker shows the window runs actually use, not the model's max.
          contextWindow: settings.ollama.numCtx,
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

  return probed.filter((model): model is ModelInfo => model !== null)
}

function openaiModels(settings: InternalSettings): ModelInfo[] {
  if (!settings.openai.enabled) return []
  const probedAt = new Date().toISOString()

  return settings.openai.models.map((id) => ({
    id,
    label: id,
    providerId: 'openai',
    contextWindow: settings.openai.numCtx,
    // Chat Completions has no capability endpoint. Tool calling is assumed;
    // the adapter surfaces a clear error if the server disagrees.
    capabilities: {
      nativeTools: true,
      thinking: false,
      jsonSchema: false,
      contextWindow: settings.openai.numCtx,
      probedAt,
    },
  }))
}
