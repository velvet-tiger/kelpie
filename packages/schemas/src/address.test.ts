import { describe, expect, it } from 'vitest'

import {
  addressBody,
  COMPANY_ADDRESS_KIND_LABELS,
  COMPANY_ADDRESS_KINDS,
  companyAddressesSchema,
  formatAddress,
  PERSON_ADDRESS_KIND_LABELS,
  PERSON_ADDRESS_KINDS,
  personAddressesSchema,
  primaryAddress,
} from './address.ts'
import type { PersonAddress } from './address.ts'

const mailingMelbourne: PersonAddress = {
  kind: 'mailing',
  line1: '1 Collins Street',
  line2: null,
  city: 'Melbourne',
  region: 'VIC',
  postalCode: '3000',
  country: 'AU',
  primary: true,
}

describe('personAddressesSchema', () => {
  it('maps snake_case wire fields and uppercases a country name to a code', () => {
    const parsed = personAddressesSchema.parse([
      {
        kind: 'home',
        line1: '1 Collins Street',
        line2: null,
        city: 'Melbourne',
        region: 'VIC',
        postal_code: '3000',
        country: 'Australia',
        primary: true,
      },
    ])

    expect(parsed).toEqual([
      {
        kind: 'home',
        line1: '1 Collins Street',
        line2: null,
        city: 'Melbourne',
        region: 'VIC',
        postalCode: '3000',
        country: 'AU',
        primary: true,
      },
    ])
  })

  it('accepts an empty list', () => {
    expect(personAddressesSchema.parse([])).toEqual([])
  })

  it('refuses two entries of the same kind', () => {
    expect(() =>
      personAddressesSchema.parse([
        { ...addressBody(mailingMelbourne), kind: 'home' },
        { ...addressBody(mailingMelbourne), kind: 'home', primary: false, city: 'Sydney' },
      ]),
    ).toThrow()
  })

  it('refuses a list with no primary', () => {
    expect(() =>
      personAddressesSchema.parse([{ ...addressBody(mailingMelbourne), primary: false }]),
    ).toThrow()
  })

  it('refuses an address with every part empty', () => {
    expect(() =>
      personAddressesSchema.parse([
        {
          kind: 'home',
          line1: null,
          line2: '  ',
          city: null,
          region: null,
          postal_code: null,
          country: null,
          primary: true,
        },
      ]),
    ).toThrow()
  })

  it('refuses an unknown country', () => {
    expect(() =>
      personAddressesSchema.parse([{ ...addressBody(mailingMelbourne), country: 'Middle Earth' }]),
    ).toThrow()
  })
})

describe('companyAddressesSchema', () => {
  it('accepts company kinds and refuses a person kind', () => {
    const parsed = companyAddressesSchema.parse([
      {
        kind: 'hq',
        line1: null,
        line2: null,
        city: 'Sydney',
        region: null,
        postal_code: null,
        country: 'AU',
        primary: true,
      },
    ])

    expect(parsed[0]?.kind).toBe('hq')
    expect(() =>
      companyAddressesSchema.parse([
        {
          kind: 'home',
          line1: null,
          line2: null,
          city: 'Sydney',
          region: null,
          postal_code: null,
          country: 'AU',
          primary: true,
        },
      ]),
    ).toThrow()
  })
})

describe('label records stay in sync with their id arrays', () => {
  it('PERSON_ADDRESS_KIND_LABELS matches PERSON_ADDRESS_KINDS', () => {
    expect(Object.keys(PERSON_ADDRESS_KIND_LABELS).sort()).toEqual([...PERSON_ADDRESS_KINDS].sort())
  })

  it('COMPANY_ADDRESS_KIND_LABELS matches COMPANY_ADDRESS_KINDS', () => {
    expect(Object.keys(COMPANY_ADDRESS_KIND_LABELS).sort()).toEqual(
      [...COMPANY_ADDRESS_KINDS].sort(),
    )
  })
})

describe('formatAddress and primaryAddress', () => {
  it('joins populated parts and names the country', () => {
    expect(formatAddress(mailingMelbourne)).toBe('1 Collins Street, Melbourne, VIC, 3000, Australia')
  })

  it('returns the primary entry', () => {
    const home: PersonAddress = { ...mailingMelbourne, kind: 'home', primary: false, city: 'Perth' }

    expect(primaryAddress([home, mailingMelbourne])).toEqual(mailingMelbourne)
    expect(primaryAddress([])).toBeUndefined()
  })
})
