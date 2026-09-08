import { describe, expect, it } from 'vitest'

import { ALL_TIMEZONES, timezonesIncluding } from './timezones.ts'

describe('ALL_TIMEZONES', () => {
  it('puts UTC first', () => {
    expect(ALL_TIMEZONES[0]).toBe('UTC')
  })

  it('includes a canonical IANA name', () => {
    expect(ALL_TIMEZONES).toContain('Australia/Sydney')
  })

  it('does not list UTC twice', () => {
    expect(ALL_TIMEZONES.filter((zone) => zone === 'UTC')).toEqual(['UTC'])
  })
})

describe('timezonesIncluding', () => {
  it('returns the full list when nothing is stored yet', () => {
    expect(timezonesIncluding('')).toBe(ALL_TIMEZONES)
  })

  it('returns the full list when the stored zone is already in it', () => {
    expect(timezonesIncluding('UTC')).toBe(ALL_TIMEZONES)
  })

  it('prepends a stored zone the runtime list does not contain', () => {
    const zones = timezonesIncluding('Mars/Olympus')

    expect(zones[0]).toBe('Mars/Olympus')
    expect(zones.slice(1)).toEqual(ALL_TIMEZONES)
  })
})
