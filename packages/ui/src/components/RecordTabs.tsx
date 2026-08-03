import type { ReactNode } from 'react'

export interface RecordTabDescriptor<TId extends string> {
  readonly id: TId
  readonly label: string
  /** Shown beside the label when greater than zero. */
  readonly count?: number
}

export interface RecordTabsProps<TId extends string> {
  readonly tabs: readonly RecordTabDescriptor<TId>[]
  readonly active: TId
  readonly onChange: (id: TId) => void
  readonly children: ReactNode
  readonly ariaLabel?: string
}

export function RecordTabs<TId extends string>({
  tabs,
  active,
  onChange,
  children,
  ariaLabel = 'Record sections',
}: RecordTabsProps<TId>): React.JSX.Element {
  return (
    <div>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="mb-6 flex flex-wrap gap-1 border-b border-border"
      >
        {tabs.map((tab) => {
          const selected = active === tab.id

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              id={`record-tab-${tab.id}`}
              onClick={() => {
                onChange(tab.id)
              }}
              className={[
                'border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                selected
                  ? 'border-accent text-accent-hover'
                  : 'border-transparent text-ink-muted hover:text-ink',
              ].join(' ')}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className="ml-1.5 tabular-nums text-ink-faint">{tab.count}</span>
              )}
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        aria-labelledby={`record-tab-${active}`}
        className="animate-fade-in space-y-8"
      >
        {children}
      </div>
    </div>
  )
}
