import { describe, expect, it } from 'vitest'

import {
  INTENT_HANDLED_TARGETS,
  customFieldsFillBlankPatch,
  parseStandardAnswer,
  valuesForObject,
} from './applyMappedFields.ts'

describe('valuesForObject', () => {
  it('skips intent-handled targets and groups the rest', () => {
    const grouped = valuesForObject(
      {
        'person.email': 'a@example.com',
        'person.summary': 'Builder',
        'person.custom_fields.region': 'EMEA',
        'deal.risks': 'Budget freeze',
      },
      'person',
    )

    expect(grouped.standard).toEqual({ summary: 'Builder' })
    expect(grouped.custom).toEqual({ region: 'EMEA' })
    expect(INTENT_HANDLED_TARGETS.has('person.email')).toBe(true)
  })
})

describe('parseStandardAnswer', () => {
  it('parses comma-separated tags', () => {
    expect(parseStandardAnswer('person', 'tags', 'inbound, partner')).toEqual(['inbound', 'partner'])
  })
})

describe('customFieldsFillBlankPatch', () => {
  it('fills only blank stored keys', () => {
    expect(
      customFieldsFillBlankPatch({ region: 'EMEA' }, { region: 'APAC', budget: '100' }),
    ).toEqual({ budget: '100' })
  })
})
