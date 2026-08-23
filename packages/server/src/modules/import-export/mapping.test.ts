import { findMatchKey } from '@kelpie/schemas'
import type { MatchKeyOption } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { buildMatchKey, centsToMoney, mapRow, moneyToCents, splitList } from './mapping.ts'
import { aliasedStageSlug, defaultColumnMap } from './presets.ts'

function keyFor(object: 'companies' | 'people' | 'positions' | 'deals', id: string): MatchKeyOption {
  const key = findMatchKey(object, id)

  if (key === undefined) {
    throw new Error(`No match key ${id} for ${object}`)
  }

  return key
}

describe('mapRow', () => {
  it('reads each Kelpie column out of the header the map names', () => {
    const mapped = mapRow(
      { 'Company Domain Name': 'acme.com', Name: 'Acme' },
      { name: 'Name', domain: 'Company Domain Name' },
    )

    expect(mapped).toEqual({ name: 'Acme', domain: 'acme.com' })
  })

  /**
   * "The file has no such column" and "the file has one and this cell is empty"
   * are different facts, and a draft has to tell them apart to know whether it
   * is being asked to write a blank.
   */
  it('leaves an unmapped column out rather than setting it blank', () => {
    const mapped = mapRow({ Name: 'Acme' }, { name: 'Name', domain: null })

    expect(mapped).toEqual({ name: 'Acme' })
    expect('domain' in mapped).toBe(false)
  })

  it('reads a mapped column the row happens not to fill as blank', () => {
    expect(mapRow({ Name: 'Acme', Domain: '' }, { name: 'Name', domain: 'Domain' })).toEqual({
      name: 'Acme',
      domain: '',
    })
  })
})

describe('splitList', () => {
  it('splits on pipes and drops blank entries', () => {
    expect(splitList('a | b ||c')).toEqual(['a', 'b', 'c'])
  })

  it('reads a blank or absent cell as no entries', () => {
    expect(splitList('')).toEqual([])
    expect(splitList(undefined)).toEqual([])
  })
})

describe('buildMatchKey', () => {
  it('normalises an email the way a write does', () => {
    const key = keyFor('people', 'email')

    expect(buildMatchKey(key, { email: '  Ada@Acme.COM ' })).toBe(
      buildMatchKey(key, { email: 'ada@acme.com' }),
    )
  })

  it('normalises a domain past its scheme, host case, and path', () => {
    const key = keyFor('companies', 'domain')

    expect(buildMatchKey(key, { domain: 'HTTPS://Acme.com/careers' })).toBe(
      buildMatchKey(key, { domain: 'acme.com' }),
    )
  })

  it('compares names and titles case-insensitively', () => {
    const key = keyFor('companies', 'name')

    expect(buildMatchKey(key, { name: 'ACME' })).toBe(buildMatchKey(key, { name: 'acme' }))
  })

  /** An external id is an opaque token from another system. Two cases are two ids. */
  it('leaves an external id case-sensitive', () => {
    const key = keyFor('deals', 'external_id')

    expect(buildMatchKey(key, { external_id: 'AB12' })).not.toBe(
      buildMatchKey(key, { external_id: 'ab12' }),
    )
  })

  it('joins every column of a composite key', () => {
    const key = keyFor('positions', 'person_email|company_domain|title')

    expect(
      buildMatchKey(key, {
        person_email: 'ada@acme.com',
        company_domain: 'acme.com',
        title: 'CTO',
      }),
    ).toBe('person_email|company_domain|title:ada@acme.com|acme.com|cto')
  })

  it('tells a two-column key apart from the three-column one over the same row', () => {
    const parts = { person_email: 'ada@acme.com', company_domain: 'acme.com', title: 'CTO' }

    expect(buildMatchKey(keyFor('positions', 'person_email|company_domain'), parts)).not.toBe(
      buildMatchKey(keyFor('positions', 'person_email|company_domain|title'), parts),
    )
  })

  it('has no key when a component is missing or blank', () => {
    const key = keyFor('positions', 'person_email|company_domain')

    expect(buildMatchKey(key, { person_email: 'ada@acme.com', company_domain: '  ' })).toBeNull()
    expect(buildMatchKey(key, { person_email: 'ada@acme.com' })).toBeNull()
    expect(buildMatchKey(key, { person_email: 'ada@acme.com', company_domain: null })).toBeNull()
  })
})

describe('moneyToCents', () => {
  it('reads the major unit, not cents', () => {
    expect(moneyToCents('12')).toBe(1200)
  })

  it('rounds to the nearest cent through the floating point', () => {
    expect(moneyToCents('19.99')).toBe(1999)
    expect(moneyToCents('0.005')).toBe(1)
  })

  it('reads a spreadsheet-formatted currency cell', () => {
    expect(moneyToCents('$1,200.00')).toBe(120_000)
    expect(moneyToCents('€ 80')).toBe(8000)
  })

  it('reads a blank cell as no value', () => {
    expect(moneyToCents('')).toBeNull()
    expect(moneyToCents(undefined)).toBeNull()
  })

  it('refuses anything that is not a number', () => {
    expect(moneyToCents('lots')).toBeUndefined()
    expect(moneyToCents('12.3.4')).toBeUndefined()
  })

  it('round-trips through the export renderer', () => {
    expect(moneyToCents(centsToMoney(120_000))).toBe(120_000)
    expect(centsToMoney(null)).toBe('')
  })
})

describe('aliasedStageSlug', () => {
  it.each([
    ['Closed Won', 'won'],
    ['closedwon', 'won'],
    ['CLOSED_WON', 'won'],
    ['Closed Lost', 'lost'],
    ['Appointment Scheduled', 'qualifying'],
    ['Negotiation/Review', 'negotiation'],
    ['Proposal/Price Quote', 'proposal'],
  ])('reads %s as %s', (raw, slug) => {
    expect(aliasedStageSlug(raw)).toBe(slug)
  })

  it('has no answer for a stage nobody named', () => {
    expect(aliasedStageSlug('Sitting On It')).toBeUndefined()
  })
})

describe('defaultColumnMap', () => {
  it('prefers the source preset over an exact header match', () => {
    // A HubSpot company export has both `Name` and `Company Domain Name`, and
    // only the preset knows the second is the domain.
    const map = defaultColumnMap('hubspot', 'companies', ['Name', 'Company Domain Name'])

    expect(map.name).toBe('Name')
    expect(map.domain).toBe('Company Domain Name')
  })

  it('maps an Attio companies export by its nested headers', () => {
    // Attio writes a linked or nested attribute as `Parent > Child`, which no
    // exact header match would catch, so the preset has to.
    const map = defaultColumnMap('attio', 'companies', [
      'Record',
      'Domains',
      'Primary location > Country',
      'Description',
    ])

    expect(map.name).toBe('Record')
    expect(map.domain).toBe('Domains')
    expect(map.hq).toBe('Primary location > Country')
  })

  it('maps an Attio people export, linking the company by name', () => {
    const map = defaultColumnMap('attio', 'people', [
      'Record',
      'Email addresses',
      'Company > Name',
      'Job title',
    ])

    expect(map.name).toBe('Record')
    expect(map.email).toBe('Email addresses')
    expect(map.company_name).toBe('Company > Name')
    expect(map.title).toBe('Job title')
    expect(map.company_domain).toBeNull()
  })

  it('falls back to an exact header match, ignoring case', () => {
    expect(defaultColumnMap('custom', 'companies', ['Name', 'DOMAIN'])).toMatchObject({
      name: 'Name',
      domain: 'DOMAIN',
    })
  })

  it('leaves a column the file has no header for unmapped', () => {
    expect(defaultColumnMap('custom', 'companies', ['name']).domain).toBeNull()
  })

  it('ignores a preset header the file does not carry', () => {
    expect(defaultColumnMap('hubspot', 'people', ['Email']).name).toBeNull()
  })

  /** A Kelpie export writes its own column names, so it maps onto itself whole. */
  it('maps a Kelpie-native file with no preset at all', () => {
    const headers = ['name', 'email', 'timezone', 'location']
    const map = defaultColumnMap('custom', 'people', headers)

    expect(map).toMatchObject({ name: 'name', email: 'email', timezone: 'timezone' })
  })
})
