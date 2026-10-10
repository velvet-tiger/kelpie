import { FORM_MAP_OBJECT_TYPES, FORM_STANDARD_MAP_FIELDS } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { checkMappedAnswers, mappedTargetsOf, mappedValueProblem } from './mappedValueChecks.ts'

describe('mappedValueProblem', () => {
  it('has a rule for every standard target a submit writes', () => {
    // A target the record's PATCH body does not know is refused as an unknown
    // key, whatever the value. So a readable value that is refused here means
    // the catalog offers a target the body has no key for.
    const samples: Readonly<Record<string, string>> = {
      text: 'a',
      long_text: 'a',
      email: 'a@example.com',
      phones: '+61 400 000 000',
      tags: 'a',
      string_array: 'a',
      boolean: 'true',
      number: '1',
      date: '2026-01-31',
      url: 'https://example.com',
    }
    const unexpected: string[] = []

    for (const objectType of FORM_MAP_OBJECT_TYPES) {
      // No submit writes an event, so it has no rule to check.
      if (objectType === 'event') continue

      for (const entry of FORM_STANDARD_MAP_FIELDS[objectType]) {
        const sample =
          entry.field === 'currency' ? 'USD' : (entry.enumValues?.[0] ?? samples[entry.valueType])

        if (sample === undefined) {
          unexpected.push(`${objectType}.${entry.field}: no sample for ${entry.valueType}`)
          continue
        }

        const problem = mappedValueProblem(`${objectType}.${entry.field}`, sample)

        if (problem !== undefined) {
          unexpected.push(`${objectType}.${entry.field}: ${problem}`)
        }
      }
    }

    expect(unexpected).toEqual([])
  })

  it.each([
    ['person.timezone', 'x'.repeat(501)],
    ['person.name', 'x'.repeat(501)],
    ['person.phones', 'x'.repeat(501)],
    ['person.relationship', 'best friends'],
    ['person.do_not_contact', 'maybe'],
    ['person.tags', 'x'.repeat(121)],
    ['company.domain', 'x'.repeat(501)],
    ['company.size_band', 'huge'],
    ['position.title', 'x'.repeat(501)],
    ['deal.value_cents', '12.5'],
    ['deal.value_cents', '-1'],
    ['deal.value_cents', 'lots'],
    ['deal.currency', 'dollars'],
    ['deal.expected_close', '2026-02-30'],
    ['raise.check_size_cents', '1e30'],
  ])('refuses %s given a value its PATCH would refuse', (target, value) => {
    expect(mappedValueProblem(target, value)).toEqual(expect.any(String))
  })

  it('has no rule for the targets it does not write through a PATCH body', () => {
    const long = 'x'.repeat(5000)

    expect(mappedValueProblem('submission', long)).toBeUndefined()
    expect(mappedValueProblem('person.address.line1', long)).toBeUndefined()
    expect(mappedValueProblem('person.custom_fields.region', long)).toBeUndefined()
    expect(mappedValueProblem('event.name', long)).toBeUndefined()
  })
})

describe('checkMappedAnswers', () => {
  it('keeps the values a record takes and names the ones it does not', () => {
    const checked = checkMappedAnswers({
      'person.email': 'alex@example.com',
      'person.summary': 'Builder',
      'deal.value_cents': 'lots',
    })

    expect(checked.accepted).toEqual({
      'person.email': 'alex@example.com',
      'person.summary': 'Builder',
    })
    expect(checked.refused).toEqual([{ target: 'deal.value_cents', reason: expect.any(String) }])
  })
})

describe('mappedTargetsOf', () => {
  const mapped = {
    'person.email': 'alex@example.com',
    'person.summary': 'Builder',
    'person.custom_fields.region': 'EMEA',
    'company.name': 'Example Co',
    'raise.tags': 'hot',
    submission: 'Hello',
  }

  it('names the targets of one record type, custom fields included', () => {
    expect(mappedTargetsOf(mapped, 'person')).toEqual([
      'person.email',
      'person.summary',
      'person.custom_fields.region',
    ])
    expect(mappedTargetsOf(mapped, 'raise')).toEqual(['raise.tags'])
  })

  it('leaves out the targets the caller excepts', () => {
    expect(mappedTargetsOf(mapped, 'person', ['person.email'])).toEqual([
      'person.summary',
      'person.custom_fields.region',
    ])
  })
})
