import { describe, expect, it } from 'vitest'

import {
  STALE_CONTACT_DAYS,
  UPCOMING_DAYS,
  addDays,
  daysBetween,
  staleContactCutoff,
  upcomingEnd,
} from './attention.ts'

describe('addDays', () => {
  it('moves forward and back', () => {
    expect(addDays('2026-06-16', 7)).toBe('2026-06-23')
    expect(addDays('2026-06-16', -14)).toBe('2026-06-02')
    expect(addDays('2026-06-16', 0)).toBe('2026-06-16')
  })

  it('crosses a month and a year boundary', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('knows February in a leap year', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })
})

describe('daysBetween', () => {
  it('counts whole days, negative when the second date is the earlier', () => {
    expect(daysBetween('2026-06-02', '2026-06-16')).toBe(14)
    expect(daysBetween('2026-06-16', '2026-06-16')).toBe(0)
    expect(daysBetween('2026-06-16', '2026-06-02')).toBe(-14)
  })

  it('is unaffected by a daylight-saving change between the two dates', () => {
    // Both dates are parsed at midday UTC rather than at local midnight, so an
    // offset change inside the span cannot round the answer to 13 or 15.
    expect(daysBetween('2026-03-29', '2026-04-12')).toBe(14)
  })

  it('inverts addDays', () => {
    expect(daysBetween(addDays('2026-06-16', -STALE_CONTACT_DAYS), '2026-06-16')).toBe(
      STALE_CONTACT_DAYS,
    )
  })
})

describe('the signal windows', () => {
  it('ends the upcoming window a week out, inclusive', () => {
    expect(upcomingEnd('2026-06-16')).toBe('2026-06-23')
    expect(daysBetween('2026-06-16', upcomingEnd('2026-06-16'))).toBe(UPCOMING_DAYS)
  })

  it('puts the stale cutoff a fortnight back, so the boundary day is still fresh', () => {
    const cutoff = staleContactCutoff('2026-06-16')

    expect(cutoff).toBe('2026-06-02')
    // The repository asks for `contacted_day < cutoff`, so a contact on the
    // cutoff itself — a fortnight ago to the day — is not yet stale.
    expect(daysBetween(cutoff, '2026-06-16')).toBe(STALE_CONTACT_DAYS)
  })
})
