import type { RiskLevel } from '../types.ts'

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
  onProgress?: (chunk: string) => void
}

export interface DiffSummary {
  path: string
  added: number
  removed: number
  lines: string[]
}

export interface ToolResult {
  ok: boolean
  /** Text handed back to the model. Keep it compact: it enters the paid prefix. */
  content: string
  diff?: DiffSummary
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Drives the permission prompt's default treatment. */
  risk: RiskLevel
  /** One line describing the specific call, shown in the transcript. */
  summarize(input: Record<string, unknown>): string
  /** Full text for the permission card when `summarize` would hide part of the call. */
  permissionDetail?(input: Record<string, unknown>): string
  /**
   * Refuse a call before the permission card appears. Returns an error message,
   * or null when the call can proceed. `execute` still validates: this hook is
   * for feedback, not the boundary itself.
   */
  validate?(input: Record<string, unknown>, context: Pick<ToolContext, 'cwd'>): string | null
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

export function failure(message: string): ToolResult {
  return { ok: false, content: message }
}

/** Truncate long output by keeping the head and tail, which is where signals live. */
export function truncate(
  text: string,
  options: { headLines?: number; tailLines?: number; headChars?: number } = {},
): string {
  const headLines = options.headLines ?? 120
  const tailLines = options.tailLines ?? 40
  const headChars = options.headChars ?? 12_000

  let output = text
  const lines = output.split('\n')
  if (lines.length > headLines + tailLines) {
    const omitted = lines.length - headLines - tailLines
    output = [
      ...lines.slice(0, headLines),
      `… ${omitted} lines omitted …`,
      ...lines.slice(-tailLines),
    ].join('\n')
  }

  if (output.length > headChars) {
    const half = Math.floor(headChars / 2)
    output = `${output.slice(0, half)}\n… ${output.length - headChars} characters omitted …\n${output.slice(-half)}`
  }

  return output
}
