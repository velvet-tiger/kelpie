import { COUNTRIES, countryName } from '@kelpie/schemas'
import type { JSX } from 'react'

import { EntitySearch } from './EntitySearch.tsx'

export interface CountrySearchProps {
  readonly value: string
  readonly onChange: (country: string) => void
  readonly disabled?: boolean | undefined
  readonly size?: 'sm' | 'md' | undefined
  readonly className?: string | undefined
}

function countryOptions(
  current: string,
): readonly { readonly id: string; readonly label: string; readonly meta?: string }[] {
  const options = COUNTRIES.map((country) => ({
    id: country.code,
    label: `${country.name} (${country.code})`,
    ...(country.aliases === undefined ? {} : { meta: country.aliases.join(', ') }),
  }))

  if (current.length === 0 || COUNTRIES.some((country) => country.code === current)) {
    return options
  }

  const name = countryName(current) ?? current

  return [{ id: current, label: `${name} (${current})` }, ...options]
}

/**
 * Searchable ISO 3166-1 alpha-2 picker.
 *
 * Accepts a stored code. The list searches English names, codes, and aliases.
 * Clearing writes an empty string so the parent can store null.
 */
export function CountrySearch({
  value,
  onChange,
  disabled,
  size = 'sm',
  className = '',
}: CountrySearchProps): JSX.Element {
  if (disabled === true) {
    const padding = size === 'md' ? 'px-2.5 py-1.5 text-[13px]' : 'px-2 py-1.5 text-[12px]'
    const label =
      value.length === 0 ? '—' : `${countryName(value) ?? value}${value.length === 2 ? ` (${value})` : ''}`

    return (
      <div
        className={`w-full rounded-md border border-border bg-surface-raised text-ink opacity-60 ${padding} ${className}`}
      >
        {label}
      </div>
    )
  }

  return (
    <EntitySearch
      options={countryOptions(value)}
      value={value}
      onChange={onChange}
      placeholder="Search countries…"
      emptyMessage="No matching countries"
      limit={20}
      size={size}
      className={className}
    />
  )
}
