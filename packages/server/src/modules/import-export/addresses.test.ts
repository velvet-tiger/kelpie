import { describe, expect, it } from 'vitest'

import { companyAddressesFromMapped, personAddressesFromMapped } from './addresses.ts'

describe('personAddressesFromMapped', () => {
  it('builds a mailing address from flattened columns', () => {
    const result = personAddressesFromMapped({
      mailing_line1: '1 Harbour',
      mailing_city: 'Melbourne',
      mailing_country: 'Australia',
    })

    expect(result.warnings).toEqual([])
    expect(result.addresses).toEqual([
      {
        kind: 'mailing',
        line1: '1 Harbour',
        line2: null,
        city: 'Melbourne',
        region: null,
        postalCode: null,
        country: 'AU',
        primary: true,
      },
    ])
  })

  it('warns on an unknown country and leaves it blank', () => {
    const result = personAddressesFromMapped({
      mailing_city: 'Melbourne',
      mailing_country: 'Narnia',
    })

    expect(result.addresses?.[0]?.country).toBeNull()
    expect(result.warnings).toEqual([
      {
        field: 'mailing_country',
        message: '"Narnia" is not a country Kelpie knows. Country left blank',
      },
    ])
  })

  it('marks the first non-empty kind primary', () => {
    const result = personAddressesFromMapped({
      work_city: 'Sydney',
      home_city: 'Melbourne',
    })

    expect(result.addresses?.map((address) => [address.kind, address.primary])).toEqual([
      ['home', true],
      ['work', false],
    ])
  })
})

describe('companyAddressesFromMapped', () => {
  it('builds hq and billing groups', () => {
    const result = companyAddressesFromMapped({
      hq_city: 'Melbourne',
      hq_country: 'AU',
      billing_city: 'Sydney',
    })

    expect(result.addresses?.map((address) => address.kind)).toEqual(['hq', 'billing'])
    expect(result.addresses?.[0]?.primary).toBe(true)
    expect(result.addresses?.[1]?.primary).toBe(false)
  })
})
