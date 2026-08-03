export interface SegmentedOption<T extends string> {
  readonly id: T
  readonly label: string
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T
  readonly onChange: (value: T) => void
  readonly options: readonly SegmentedOption<T>[]
  readonly ariaLabel: string
}

/** A small either-or toggle: board or list, open or all, open or closed. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border bg-surface-raised p-0.5"
    >
      {options.map((option) => {
        const selected = value === option.id

        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              onChange(option.id)
            }}
            className={[
              'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
              selected ? 'bg-accent-soft text-accent-hover' : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
