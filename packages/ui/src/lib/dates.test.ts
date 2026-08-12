import { describe, expect, it } from 'vitest'

import { formatDate, formatDateTime, formatRelativeTime, monthLabel, resolveTimezone } from './dates.ts'

/**
 * The timezone fallback chain, and that each formatter actually renders in the
 * zone it is given rather than the machine's own.
 */

describe('resolveTimezone', () => {
  it('prefers the account timezone over the workspace one', () => {
    expect(resolveTimezone('America/New_York', 'Australia/Sydney')).toBe('America/New_York')
  })

  it('falls back to the workspace timezone while the account preference has not loaded', () => {
    expect(resolveTimezone(undefined, 'Australia/Sydney')).toBe('Australia/Sydney')
  })

  it('falls back to UTC when neither is known yet', () => {
    expect(resolveTimezone(undefined, undefined)).toBe('UTC')
  })
})

describe('formatDateTime', () => {
  // 23:30 UTC on the 15th is already the 16th in Sydney (UTC+11 in January)
  // but still the 15th in Los Angeles (UTC-8).
  const instant = new Date('2026-01-15T23:30:00.000Z')

  it('renders the day the given zone is in, not the machine\'s own', () => {
    expect(formatDateTime(instant, 'Australia/Sydney')).toContain('16')
    expect(formatDateTime(instant, 'America/Los_Angeles')).toContain('15')
  })

  it('does not hardcode a locale', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(instant)

    expect(formatDateTime(instant, 'UTC')).toBe(expected)
  })
})

describe('formatDate', () => {
  it('does not hardcode a locale', () => {
    const instant = new Date('2026-01-15T10:00:00.000Z')
    const expected = new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(instant)

    expect(formatDate(instant, 'UTC')).toBe(expected)
  })
})

describe('formatRelativeTime', () => {
  it('falls back to the absolute time, in the given zone, for a future timestamp', () => {
    const now = new Date('2026-01-15T10:00:00.000Z')
    const future = new Date('2026-01-15T23:30:00.000Z')

    expect(formatRelativeTime(future, 'Australia/Sydney', now)).toBe(
      formatDateTime(future, 'Australia/Sydney'),
    )
  })

  it('does not need a zone for the elapsed-time form, only for the future fallback', () => {
    const now = new Date('2026-01-15T10:03:00.000Z')
    const past = new Date('2026-01-15T10:00:00.000Z')

    expect(formatRelativeTime(past, 'UTC', now)).toBe('3 minutes ago')
  })
})

describe('monthLabel', () => {
  // 23:30 UTC on 31 Dec 2025 is already 1 Jan 2026 in Sydney, but still
  // 31 Dec 2025 in Los Angeles.
  const value = new Date('2025-12-31T23:30:00.000Z')
  const now = new Date('2026-01-02T00:00:00.000Z')

  it('groups with the current year, dropped from the label, in a zone already past the boundary', () => {
    expect(monthLabel(value, 'Australia/Sydney', now)).toBe('January')
  })

  it('groups with the prior year, named in the label, in a zone not yet past the boundary', () => {
    expect(monthLabel(value, 'America/Los_Angeles', now)).toBe('December 2025')
  })
})
