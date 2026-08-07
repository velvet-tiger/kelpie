import { describe, expect, it } from 'vitest'

import { dayIn, timezoneSchema } from './timezones.ts'

describe('timezoneSchema', () => {
  it('takes a zone the platform can resolve', () => {
    expect(timezoneSchema.safeParse('Australia/Sydney').success).toBe(true)
    expect(timezoneSchema.safeParse('Europe/London').success).toBe(true)
    expect(timezoneSchema.safeParse('UTC').success).toBe(true)
  })

  it('refuses a zone the platform cannot resolve', () => {
    expect(timezoneSchema.safeParse('Mars/Olympus').success).toBe(false)
    expect(timezoneSchema.safeParse('Australia/Sydeny').success).toBe(false)
  })

  it('refuses blank, which no caller needs a separate min(1) for', () => {
    expect(timezoneSchema.safeParse('').success).toBe(false)
    expect(timezoneSchema.safeParse('   ').success).toBe(false)
  })

  it('takes what Intl takes, which is wider than the canonical names', () => {
    // Pinned because it is surprising, not because it is wanted: a caller
    // comparing a stored zone to a canonical one cannot assume they match.
    expect(timezoneSchema.safeParse('australia/sydney').success).toBe(true)
    expect(timezoneSchema.safeParse('Asia/Calcutta').success).toBe(true)
  })
})

describe('dayIn', () => {
  it('answers the zone-local day, not the UTC one', () => {
    const lateInLondon = new Date('2026-06-15T23:30:00.000Z')

    expect(dayIn('Europe/London', lateInLondon)).toBe('2026-06-16')
    expect(dayIn('Australia/Melbourne', lateInLondon)).toBe('2026-06-16')
    expect(dayIn('America/New_York', lateInLondon)).toBe('2026-06-15')
    expect(dayIn('UTC', lateInLondon)).toBe('2026-06-15')
  })

  it('pads the month and day, so the result always sorts as text', () => {
    expect(dayIn('UTC', new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-05')
  })

  it('follows the zone across a daylight-saving change', () => {
    // Melbourne leaves daylight saving at 3am on 2026-04-05, so the same UTC
    // instant sits on either side of midnight there depending on the offset.
    expect(dayIn('Australia/Melbourne', new Date('2026-04-04T13:30:00.000Z'))).toBe('2026-04-05')
    expect(dayIn('Australia/Melbourne', new Date('2026-04-05T13:30:00.000Z'))).toBe('2026-04-05')
  })

  it('throws for a zone the platform cannot resolve, rather than answering in UTC', () => {
    expect(() => dayIn('Mars/Olympus', new Date())).toThrow(RangeError)
  })
})
