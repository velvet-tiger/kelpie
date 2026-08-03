export interface AddButtonProps {
  readonly onClick: () => void
  readonly label?: string
  readonly compact?: boolean
}

export function AddButton({
  onClick,
  label = 'Add',
  compact = false,
}: AddButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-md border border-border font-medium text-ink transition',
        'hover:border-border-strong hover:bg-surface-sunken',
        compact ? 'h-6 w-6 text-[14px] leading-none' : 'h-7 w-7 text-[16px] leading-none',
      ].join(' ')}
    >
      +
    </button>
  )
}

export interface SectionHeaderProps {
  readonly title: string
  readonly description?: string
  readonly onAdd?: () => void
  readonly addLabel?: string
  readonly compact?: boolean
}

export function SectionHeader({
  title,
  description,
  onAdd,
  addLabel = 'Add',
  compact = false,
}: SectionHeaderProps): React.JSX.Element {
  return (
    <div
      className={
        compact
          ? 'flex items-start justify-between gap-2'
          : 'mb-3 flex items-start justify-between gap-2'
      }
    >
      <div className="min-w-0">
        <h2 className={compact ? 'text-[12px] font-semibold text-ink' : 'text-[13px] font-semibold text-ink'}>
          {title}
        </h2>
        {description !== undefined && (
          <p className="mt-0.5 text-[11px] text-ink-faint">{description}</p>
        )}
      </div>
      {onAdd !== undefined && <AddButton onClick={onAdd} label={addLabel} compact={compact} />}
    </div>
  )
}
