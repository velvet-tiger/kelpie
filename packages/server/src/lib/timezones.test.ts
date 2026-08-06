import { describe, expect, it } from 'vitest'

import { timezoneSchema } from './timezones.ts'

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
