/**
 * The smallest markdown the agent replies actually need: prose and fenced
 * code. Bold, links, and lists would need a real parser; agents write short
 * answers between tool calls, not documents.
 */

export type Segment = { type: 'text' | 'code'; text: string; language?: string }

/**
 * Split a reply into prose and fenced code.
 *
 * An unclosed fence counts as code to the end of the string: that is what
 * streaming looks like mid-turn, and it keeps the backticks from flashing.
 */
export function segments(source: string): Segment[] {
  const parts: Segment[] = []
  const pattern = /```([^\n]*)\n?([\s\S]*?)(?:```|$)/g
  let last = 0

  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ type: 'text', text: source.slice(last, index) })

    const language = (match[1] ?? '').trim()
    parts.push({
      type: 'code',
      text: (match[2] ?? '').replace(/\n$/, ''),
      ...(language ? { language } : {}),
    })
    last = index + match[0].length
  }

  if (last < source.length) parts.push({ type: 'text', text: source.slice(last) })
  return parts.length > 0 ? parts : [{ type: 'text', text: source }]
}
