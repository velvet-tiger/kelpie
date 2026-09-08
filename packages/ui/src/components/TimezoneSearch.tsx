import type { JSX } from 'react'

import { timezonesIncluding } from '../lib/timezones.ts'

import { EntitySearch } from './EntitySearch.tsx'

export interface TimezoneSearchProps {
  readonly value: string
  readonly onChange: (timezone: string) => void
  readonly required?: boolean | undefined
  readonly disabled?: boolean | undefined
  readonly size?: 'sm' | 'md' | undefined
  readonly className?: string | undefined
}

/**
 * Searchable IANA timezone picker.
 *
 * The person sidebar used to be a free-text InlineEdit, which accepted anything
 * and offered no list. Account preferences already searched the full ICU set;
 * this is that control, shared with Events and workspace settings.
 *
 * Clearing a required field is ignored: the stored value stays until a real
 * zone is picked, so an Event or workspace cannot PATCH an empty string.
 */
export function TimezoneSearch({
  value,
  onChange,
  required,
  disabled,
  size = 'sm',
  className = '',
}: TimezoneSearchProps): JSX.Element {
  const options = timezonesIncluding(value).map((zone) => ({ id: zone, label: zone }))

  if (disabled === true) {
    const padding = size === 'md' ? 'px-2.5 py-1.5 text-[13px]' : 'px-2 py-1.5 text-[12px]'

    return (
      <div
        className={`w-full rounded-md border border-border bg-surface-raised text-ink opacity-60 ${padding} ${className}`}
      >
        {value.length > 0 ? value : '—'}
      </div>
    )
  }

  return (
    <EntitySearch
      options={options}
      value={value}
      onChange={(next) => {
        if (required === true && next.length === 0) {
          return
        }

        onChange(next)
      }}
      placeholder="Search time zones…"
      emptyMessage="No matching time zones"
      limit={20}
      required={required}
      size={size}
      className={className}
    />
  )
}
