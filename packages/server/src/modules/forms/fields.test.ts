import { describe, expect, it } from 'vitest'

import { findFieldProblems, reconcileFields, storedOptions } from './fields.ts'
import type { FieldDraft, OptionDraft, StoredField } from './fields.ts'
import type { FormFieldMapTarget, FormFieldType } from './schema.ts'

/**
 * The per-form rules a check constraint cannot hold.
 *
 * Every one of these is a statement about a set of rows rather than about a
 * single one, which is why they live in the service layer and are tested here
 * instead of by the database refusing an insert.
 */

interface DraftOverrides {
  readonly label?: string
  readonly type?: FormFieldType
  readonly mapTo?: FormFieldMapTarget
  readonly options?: readonly OptionDraft[]
  readonly listIds?: readonly string[]
  readonly listLabels?: Readonly<Record<string, string>>
}

function draft(overrides: DraftOverrides = {}): FieldDraft {
  return {
    label: overrides.label ?? 'Email',
    type: overrides.type ?? 'email',
    required: true,
    mapTo: overrides.mapTo ?? 'person.email',
    options: overrides.options ?? [],
    placeholder: null,
    statement: null,
    consentPurposeIds: [],
    consentPurposeLabels: {},
    listIds: overrides.listIds ?? [],
    listLabels: overrides.listLabels ?? {},
  }
}

const email = draft()
const name = draft({ label: 'Name', type: 'text', mapTo: 'person.name' })

describe('findFieldProblems', () => {
  it('accepts the contact form the mockup ships as its template', () => {
    const problems = findFieldProblems([
      name,
      email,
      draft({ label: 'Company', type: 'text', mapTo: 'company.name' }),
      draft({ label: 'Job title', type: 'text', mapTo: 'position.title' }),
      draft({ label: 'Message', type: 'textarea', mapTo: 'submission' }),
    ], false)

    expect(problems).toEqual([])
  })

  /** Without one there is nothing to match a Person on, so every submit would be a 422. */
  it('refuses a form with no person.email mapping', () => {
    const problems = findFieldProblems([name], false)

    expect(problems).toEqual([
      { field: 'fields', message: 'A form needs exactly one field mapped to person.email' },
    ])
  })

  it('refuses two fields mapped to the same CRM target', () => {
    const problems = findFieldProblems([email, name, draft({ label: 'Full name', type: 'text', mapTo: 'person.name' })], false)

    expect(problems).toEqual([
      { field: 'fields.2.map_to', message: 'Another field already maps to person.name' },
    ])
  })

  /** `submission` writes nothing, so several fields can share it without ambiguity. */
  it('allows any number of submission-only fields', () => {
    const problems = findFieldProblems([
      email,
      draft({ label: 'Message', type: 'textarea', mapTo: 'submission' }),
      draft({ label: 'How did you hear about us?', type: 'text', mapTo: 'submission' }),
    ], false)

    expect(problems).toEqual([])
  })

  it('refuses a select with no options', () => {
    const problems = findFieldProblems([email, draft({ label: 'Size', type: 'select', mapTo: 'submission' })], false)

    expect(problems).toEqual([
      { field: 'fields.1.options', message: 'A select field needs at least one option' },
    ])
  })

  it('refuses options on a field that does not render them', () => {
    const problems = findFieldProblems([
      email,
      draft({
        label: 'Message',
        type: 'textarea',
        mapTo: 'submission',
        options: [{ key: 'a', value: 'A', valueType: 'string' }],
      }),
    ], false)

    expect(problems).toEqual([{ field: 'fields.1.options', message: 'A textarea field has no options' }])
  })

  /** A stored answer holds the key, so a duplicate makes an old submission ambiguous. */
  it('refuses two options sharing a key', () => {
    const problems = findFieldProblems([
      email,
      draft({
        label: 'Size',
        type: 'select',
        mapTo: 'submission',
        options: [
          { key: 'small', value: '1-10', valueType: 'string' },
          { key: 'small', value: '11-50', valueType: 'string' },
        ],
      }),
    ], false)

    expect(problems).toEqual([
      { field: 'fields.1.options.1.key', message: 'Another option already uses "small"' },
    ])
  })

  it('reports a missing email mapping and a bad select together', () => {
    const problems = findFieldProblems([draft({ label: 'Size', type: 'select', mapTo: 'submission' })], false)

    expect(problems).toHaveLength(2)
  })

  /**
   * A Deal belongs to a Company, and a submit resolves one only from a company
   * answer. Without one the form would quietly never create a deal, which is
   * worse than being told at configuration time.
   */
  describe('a form that creates deals', () => {
    it('refuses a field list with no company mapping', () => {
      const problems = findFieldProblems([name, email], true)

      expect(problems).toEqual([
        {
          field: 'fields',
          message: 'A form that creates deals needs a field mapped to company.name or company.domain',
        },
      ])
    })

    it('accepts a company name mapping', () => {
      const company = draft({ label: 'Company', type: 'text', mapTo: 'company.name' })

      expect(findFieldProblems([name, email, company], true)).toEqual([])
    })

    it('accepts a company domain mapping', () => {
      const website = draft({ label: 'Website', type: 'text', mapTo: 'company.domain' })

      expect(findFieldProblems([name, email, website], true)).toEqual([])
    })

    /** The same list is fine on a form that does not create deals. */
    it('asks for nothing extra when the form makes no deals', () => {
      expect(findFieldProblems([name, email], false)).toEqual([])
    })
  })

  describe('expanded map targets', () => {
    const customDefs = [
      { objectType: 'person' as const, key: 'region', label: 'Region', type: 'text' as const },
    ]

    it('accepts a standard field outside the legacy enum', () => {
      const summary = draft({ label: 'About you', type: 'textarea', mapTo: 'person.summary' })

      expect(findFieldProblems([name, email, summary], false, { customFieldDefinitions: customDefs })).toEqual([])
    })

    it('accepts a workspace custom field target', () => {
      const region = draft({
        label: 'Region',
        type: 'text',
        mapTo: 'person.custom_fields.region',
      })

      expect(findFieldProblems([name, email, region], false, { customFieldDefinitions: customDefs })).toEqual([])
    })

    it('refuses an unknown map target', () => {
      const problems = findFieldProblems(
        [name, email, draft({ label: 'Ghost', type: 'text', mapTo: 'person.custom_fields.missing' })],
        false,
        { customFieldDefinitions: customDefs },
      )

      expect(problems).toEqual([
        { field: 'fields.2.map_to', message: 'Unknown map target person.custom_fields.missing' },
      ])
    })

    it('refuses an incompatible field type for the target', () => {
      const problems = findFieldProblems(
        [name, email, draft({ label: 'Consent', type: 'consent', mapTo: 'person.summary' })],
        false,
        { customFieldDefinitions: customDefs },
      )

      expect(problems.some((problem) => problem.field === 'fields.2.type')).toBe(true)
    })
  })

  describe('an Add to list field', () => {
    function listField(overrides: DraftOverrides = {}): FieldDraft {
      return draft({
        label: 'Add me to the mailing list',
        type: 'list',
        mapTo: 'lists',
        listIds: ['list_news'],
        ...overrides,
      })
    }

    it('accepts one or more lists, and two fields offering lists', () => {
      const problems = findFieldProblems(
        [email, listField(), listField({ listIds: ['list_events', 'list_news'] })],
        false,
      )

      expect(problems).toEqual([])
    })

    it('refuses a list field with no lists', () => {
      expect(findFieldProblems([email, listField({ listIds: [] })], false)).toEqual([
        { field: 'fields.1.list_ids', message: 'A list field needs at least one list' },
      ])
    })

    it('refuses a list offered twice on one field', () => {
      expect(findFieldProblems([email, listField({ listIds: ['list_news', 'list_news'] })], false)).toEqual([
        { field: 'fields.1.list_ids', message: 'A list field lists each list only once' },
      ])
    })

    it('refuses a list field mapped anywhere but lists', () => {
      const problems = findFieldProblems([email, listField({ mapTo: 'submission' })], false)

      expect(problems.some((problem) => problem.field === 'fields.1.map_to')).toBe(true)
    })

    it('refuses another type mapped to lists', () => {
      expect(findFieldProblems([email, listField({ type: 'text' })], false)).toEqual([
        { field: 'fields.1.type', message: 'A lists field must be of type "list"' },
        { field: 'fields.1.list_ids', message: 'A text field offers no lists' },
      ])
    })
  })
})

describe('reconcileFields', () => {
  /** The stored shape is the draft's, so a round trip compares equal. */
  function stored(fields: readonly FieldDraft[]): StoredField[] {
    return fields.map((field, index) => ({
      ...field,
      id: `ff_${String(index)}`,
      options: storedOptions(field.options),
    }))
  }

  const list = [name, email]
  const message = draft({ label: 'Message', type: 'textarea', mapTo: 'submission' })

  it('sees no change in a list that was sent back unaltered, with or without its ids', () => {
    expect(reconcileFields(stored(list), list)).toEqual({
      keptIds: ['ff_0', 'ff_1'],
      removedIds: [],
      changed: false,
      problems: [],
    })
    expect(
      reconcileFields(stored(list), [{ ...name, id: 'ff_0' }, { ...email, id: 'ff_1' }]).changed,
    ).toBe(false)
  })

  it('gives only an added field a new id', () => {
    const result = reconcileFields(stored(list), [...list, message])

    expect(result.keptIds).toEqual(['ff_0', 'ff_1', null])
    expect(result.removedIds).toEqual([])
    expect(result.changed).toBe(true)
  })

  it('removes only the field the list dropped', () => {
    const result = reconcileFields(stored(list), [email])

    expect(result.keptIds).toEqual(['ff_1'])
    expect(result.removedIds).toEqual(['ff_0'])
    expect(result.changed).toBe(true)
  })

  it('keeps the id of an edited field that names it', () => {
    const renamed = { ...name, id: 'ff_0', label: 'Full name' }
    const result = reconcileFields(stored(list), [renamed, email])

    expect(result.keptIds).toEqual(['ff_0', 'ff_1'])
    expect(result.removedIds).toEqual([])
    expect(result.changed).toBe(true)
  })

  /** Without an id there is nothing to say an edited field is the stored one. */
  it('treats an edited field with no id as a new field', () => {
    const result = reconcileFields(stored(list), [{ ...name, label: 'Full name' }, email])

    expect(result.keptIds).toEqual([null, 'ff_1'])
    expect(result.removedIds).toEqual(['ff_0'])
  })

  /** Order is what the embed renders, so reordering is a change even though nothing else moved. */
  it('sees a reorder, and keeps every id through it', () => {
    const result = reconcileFields(stored(list), [email, name])

    expect(result.keptIds).toEqual(['ff_1', 'ff_0'])
    expect(result.removedIds).toEqual([])
    expect(result.changed).toBe(true)
  })

  it('does not give a field with no id the stored field another one names', () => {
    const twins = stored([email, message, message])
    const result = reconcileFields(twins, [email, message, { ...message, id: 'ff_1' }])

    expect(result.keptIds).toEqual(['ff_0', 'ff_2', 'ff_1'])
    expect(result.changed).toBe(true)
  })

  it('refuses an id the form does not have, and an id used twice', () => {
    const result = reconcileFields(stored(list), [
      { ...name, id: 'ff_0' },
      { ...email, id: 'ff_0' },
      { ...message, id: 'ff_other' },
    ])

    expect(result.problems).toEqual([
      { field: 'fields.1.id', message: 'Another field already uses the id ff_0' },
      { field: 'fields.2.id', message: 'This form has no field ff_other' },
    ])
  })

  it('sees an option label edited', () => {
    const select = (value: string): FieldDraft =>
      draft({
        label: 'Size',
        type: 'select',
        mapTo: 'submission',
        options: [{ key: 'small', value, valueType: 'string' }],
      })
    const before = stored([email, select('1-10')])

    expect(reconcileFields(before, [email, { ...select('1 to 10'), id: 'ff_1' }])).toEqual({
      keptIds: ['ff_0', 'ff_1'],
      removedIds: [],
      changed: true,
      problems: [],
    })
  })

  it('sees a list added to a list field, and a checkbox label edited', () => {
    const lists = (listIds: readonly string[], listLabels: Readonly<Record<string, string>>): FieldDraft =>
      draft({ label: 'Lists', type: 'list', mapTo: 'lists', listIds, listLabels })
    const before = stored([email, lists(['list_news'], {})])
    const changed = (field: FieldDraft): boolean =>
      reconcileFields(before, [email, { ...field, id: 'ff_1' }]).changed

    expect(changed(lists(['list_news'], {}))).toBe(false)
    expect(changed(lists(['list_news', 'list_events'], {}))).toBe(true)
    expect(changed(lists(['list_news'], { list_news: 'Yes!' }))).toBe(true)
  })
})

describe('storedOptions', () => {
  it('keeps the order it was given, because that is the order the dropdown shows', () => {
    const stored = storedOptions([
      { key: 'small', value: '1-10', valueType: 'string' },
      { key: 'large', value: '200+', valueType: 'number' },
    ])

    expect(stored).toEqual([
      { key: 'small', value: '1-10', valueType: 'string' },
      { key: 'large', value: '200+', valueType: 'number' },
    ])
  })
})
