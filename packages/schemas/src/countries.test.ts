import { describe, expect, it } from 'vitest'

import { COUNTRIES, countryName, isCountryCode, normaliseCountry } from './countries.ts'

describe('country catalog', () => {
  it('has unique codes', () => {
    const codes = COUNTRIES.map((country) => country.code)

    expect(new Set(codes).size).toBe(codes.length)
  })

  it('stores codes as two uppercase letters', () => {
    for (const country of COUNTRIES) {
      expect(country.code).toMatch(/^[A-Z]{2}$/)
    }
  })

  it('resolves a code, a name, and a listed alias', () => {
    expect(normaliseCountry('au')).toBe('AU')
    expect(normaliseCountry('Australia')).toBe('AU')
    expect(normaliseCountry('USA')).toBe('US')
    expect(normaliseCountry('United Kingdom')).toBe('GB')
    expect(normaliseCountry('')).toBeNull()
    expect(normaliseCountry('Middle Earth')).toBeNull()
  })

  it('looks up the English name from a code', () => {
    expect(countryName('AU')).toBe('Australia')
    expect(isCountryCode('AU')).toBe(true)
    expect(isCountryCode('XX')).toBe(false)
  })
})
