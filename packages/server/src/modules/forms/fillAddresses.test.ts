import { describe, expect, it } from 'vitest'

import { fillCompanyAddresses, fillPersonAddresses } from './fillAddresses.ts'

describe('fillPersonAddresses', () => {
  it('composes a mailing address from parts when none is stored', () => {
    const next = fillPersonAddresses([], {
      'address.city': 'Melbourne',
      'address.country': 'Australia',
    })

    expect(next).toEqual([
      {
        kind: 'mailing',
        line1: null,
        line2: null,
        city: 'Melbourne',
        region: null,
        postalCode: null,
        country: 'AU',
        primary: true,
      },
    ])
  })

  it('fills only blank parts on an existing kind', () => {
    const stored = [
      {
        kind: 'mailing' as const,
        line1: '1 Harbour',
        line2: null,
        city: null,
        region: null,
        postalCode: null,
        country: 'AU',
        primary: true,
      },
    ]

    const next = fillPersonAddresses(stored, {
      'address.city': 'Sydney',
      'address.line1': '99 Overwrite',
    })

    expect(next?.[0]?.line1).toBe('1 Harbour')
    expect(next?.[0]?.city).toBe('Sydney')
  })

  it('leaves country blank when the answer is not a known country', () => {
    const next = fillPersonAddresses([], {
      'address.city': 'Melbourne',
      'address.country': 'Narnia',
    })

    expect(next?.[0]?.country).toBeNull()
    expect(next?.[0]?.city).toBe('Melbourne')
  })
})

describe('fillCompanyAddresses', () => {
  it('defaults to an hq kind', () => {
    const next = fillCompanyAddresses([], { 'address.city': 'Sydney' })

    expect(next?.[0]?.kind).toBe('hq')
    expect(next?.[0]?.primary).toBe(true)
  })
})
