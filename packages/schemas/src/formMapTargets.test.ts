import { describe, expect, it } from 'vitest'

import type { CustomFieldDefinitionRef } from './formMapTargets.ts'
import {
  buildCustomMapTarget,
  isCompatibleFormFieldType,
  isKnownMapTarget,
  isRepeatableMapTarget,
  labelForMapTarget,
  listMapTargetEntries,
  parseFormMapTarget,
  resolveMapTargetEntry,
  suggestedFormFieldType,
} from './formMapTargets.ts'

const customDefs: readonly CustomFieldDefinitionRef[] = [
  {
    objectType: 'person',
    key: 'budget_owner',
    label: 'Budget owner',
    type: 'text',
  },
  {
    objectType: 'deal',
    key: 'region',
    label: 'Region',
    type: 'select',
  },
]

describe('parseFormMapTarget', () => {
  it('parses submission and consent specials', () => {
    expect(parseFormMapTarget('submission')?.objectType).toBe('submission')
    expect(parseFormMapTarget('person.consent')?.objectType).toBe('consent')
  })

  it('parses standard fields', () => {
    expect(parseFormMapTarget('person.summary')).toEqual({
      objectType: 'person',
      fieldPath: 'summary',
      isCustomField: false,
    })
  })

  it('parses custom field targets', () => {
    expect(parseFormMapTarget('person.custom_fields.budget_owner')).toEqual({
      objectType: 'person',
      fieldPath: 'custom_fields.budget_owner',
      isCustomField: true,
      customFieldKey: 'budget_owner',
    })
  })

  it('rejects unknown shapes', () => {
    expect(parseFormMapTarget('person.unknown_field')).toBeUndefined()
    expect(parseFormMapTarget('not.valid.at.all')).toBeUndefined()
  })
})

describe('resolveMapTargetEntry', () => {
  it('resolves standard and custom targets', () => {
    expect(resolveMapTargetEntry('deal.risks')?.fieldKind).toBe('standard')
    expect(
      resolveMapTargetEntry(buildCustomMapTarget('person', 'budget_owner'), customDefs)?.fieldKind,
    ).toBe('custom')
  })

  it('returns undefined for unknown custom keys', () => {
    expect(resolveMapTargetEntry('person.custom_fields.missing', customDefs)).toBeUndefined()
  })
})

describe('labelForMapTarget', () => {
  it('labels legacy and expanded targets', () => {
    expect(labelForMapTarget('person.email')).toBe('Person · email')
    expect(labelForMapTarget('person.summary')).toBe('Person · summary')
    expect(labelForMapTarget(buildCustomMapTarget('person', 'budget_owner'), customDefs)).toBe(
      'Person · Budget owner (custom)',
    )
  })
})

describe('isRepeatableMapTarget', () => {
  it('allows submission and consent to repeat', () => {
    expect(isRepeatableMapTarget('submission')).toBe(true)
    expect(isRepeatableMapTarget('person.consent')).toBe(true)
    expect(isRepeatableMapTarget('person.name')).toBe(false)
  })
})

describe('suggestedFormFieldType', () => {
  it('suggests control types from target value types', () => {
    expect(suggestedFormFieldType('person.email')).toBe('email')
    expect(suggestedFormFieldType('deal.risks')).toBe('textarea')
    expect(suggestedFormFieldType('company.stage')).toBe('select')
  })
})

describe('isCompatibleFormFieldType', () => {
  it('requires consent types for person.consent', () => {
    expect(isCompatibleFormFieldType('consent', 'person.consent')).toBe(true)
    expect(isCompatibleFormFieldType('text', 'person.consent')).toBe(false)
  })

  it('accepts text for most string targets', () => {
    expect(isCompatibleFormFieldType('text', 'person.summary')).toBe(true)
    expect(isCompatibleFormFieldType('textarea', 'person.summary')).toBe(true)
  })
})

describe('listMapTargetEntries', () => {
  it('includes custom definitions', () => {
    const targets = new Set(listMapTargetEntries(customDefs).map((entry) => entry.target))

    expect(targets.has('person.summary')).toBe(true)
    expect(targets.has(buildCustomMapTarget('person', 'budget_owner'))).toBe(true)
  })
})

describe('isKnownMapTarget', () => {
  it('knows standard and workspace custom targets', () => {
    expect(isKnownMapTarget('raise.summary')).toBe(true)
    expect(isKnownMapTarget(buildCustomMapTarget('deal', 'region'), customDefs)).toBe(true)
    expect(isKnownMapTarget('person.custom_fields.ghost', customDefs)).toBe(false)
  })
})
