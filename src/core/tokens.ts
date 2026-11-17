/**
 * Token estimation.
 *
 * Local models do not expose a tokenizer, so the first turn must be estimated.
 * After that, the previous response's `prompt_eval_count` / `eval_count` gives us
 * ground truth for the context we just sent, and we only estimate the delta.
 *
 * This module is deliberately dependency-free so it runs under `node --test`.
 */

export type TextKind = 'code' | 'prose' | 'mixed'

/** Rough characters-per-token by content kind, calibrated on Qwen-family models. */
const CHARS_PER_TOKEN: Record<TextKind, number> = {
  prose: 4.0,
  code: 3.5,
  mixed: 3.75,
}

export interface EstimateOptions {
  /** Per-message overhead for role and framing, in tokens. */
  messageOverhead?: number
}

export function estimateTokens(text: string, kind: TextKind = 'mixed'): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN[kind])
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>,
  options: EstimateOptions = {},
): number {
  const overhead = options.messageOverhead ?? 4
  let total = 0
  for (const message of messages) {
    total += overhead + estimateTokens(message.content)
  }
  return total
}

/**
 * Blend an estimate with a measured value.
 *
 * Once a provider reports real counts, prefer the measurement and use the
 * estimate only to scale it slightly. Returns the estimate when nothing has been
 * measured yet.
 */
export function reconcile(
  estimate: number,
  measured: number | null,
  estimateForMeasured: number,
): number {
  if (measured == null || estimateForMeasured <= 0) return estimate
  const correction = measured / estimateForMeasured
  return Math.max(0, Math.round(estimate * correction))
}

/** Context usage as a 0..1 fraction, clamped. */
export function contextFraction(used: number, window: number): number {
  if (window <= 0) return 0
  return Math.min(1, Math.max(0, used / window))
}
