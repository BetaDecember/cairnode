import type { TranscriptItem } from '../lib/transcript'
import { BlockView } from './blocks'

export function Transcript({ items }: { items: TranscriptItem[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-7">
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <div className="h-1" />
      </div>
    </div>
  )
}

function Item({ item }: { item: TranscriptItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-panel rounded-br-[4px] bg-panel-2 px-3.5 py-2.5 text-[13.5px] leading-[1.6] whitespace-pre-wrap text-ink">
          {item.text}
        </div>
      </div>
    )
  }

  if (item.kind === 'divider') {
    return (
      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[10.5px] tracking-[0.02em] text-ink-faint">{item.label}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {item.blocks.map((block) => (
        <BlockView key={blockKey(block)} block={block} />
      ))}
    </div>
  )
}

function blockKey(block: { type: string; id?: string }): string {
  return block.id ?? block.type
}
