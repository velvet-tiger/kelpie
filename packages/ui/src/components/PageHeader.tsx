import type { ReactNode } from 'react'

import { AddButton } from './SectionHeader.tsx'

export interface PageHeaderProps {
  readonly title: string
  readonly description?: string
  readonly actions?: ReactNode
  readonly onAdd?: () => void
  readonly addLabel?: string
}

export function PageHeader({
  title,
  description,
  actions,
  onAdd,
  addLabel = 'Add',
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-0.5 text-[13px] text-ink-muted">{description}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        {onAdd !== undefined && <AddButton onClick={onAdd} label={addLabel} />}
      </div>
    </div>
  )
}

export interface FilterBarProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
}

/**
 * The list filter box. What it types goes to the API as `?q=`, so this is the
 * one place a page decides what "filter" means for its resource.
 */
export function FilterBar({
  value,
  onChange,
  placeholder = 'Filter…',
}: FilterBarProps): React.JSX.Element {
  return (
    <input
      value={value}
      onChange={(event) => {
        onChange(event.target.value)
      }}
      placeholder={placeholder}
      className="mb-3 w-full max-w-xs rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[13px] outline-none placeholder:text-ink-faint focus:border-accent"
    />
  )
}
