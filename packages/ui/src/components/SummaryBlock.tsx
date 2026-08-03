import { InlineEdit } from './InlineEdit.tsx'

export interface SummaryBlockProps {
  readonly value: string
  readonly onChange: (value: string) => void
}

/**
 * The agent-facing summary, at the top of a record's overview.
 *
 * It sits above everything else because it is the field an agent reads first;
 * `brief.md` makes it a record field rather than something buried in notes.
 */
export function SummaryBlock({ value, onChange }: SummaryBlockProps): React.JSX.Element {
  return (
    <div className="mb-5 border-b border-border pb-4">
      <div className="mb-1 text-[11px] font-medium text-ink-faint">Summary</div>
      <InlineEdit
        value={value}
        onChange={onChange}
        multiline
        displayClassName="text-[13px] leading-relaxed text-ink not-italic"
        emptyLabel="Add a summary…"
      />
    </div>
  )
}
