import type { ProviderId } from '@core/settings'

/** Human labels for the two adapters; the provider id stays the storage key. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI-compatible',
}

export function providerLabel(id: string): string {
  return (PROVIDER_LABELS as Record<string, string>)[id] ?? id
}
