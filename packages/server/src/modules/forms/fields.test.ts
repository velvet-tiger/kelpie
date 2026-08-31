import { describe, expect, it } from 'vitest'

import { fieldsDiffer, findFieldProblems, storedOptions } from './fields.ts'
import type { FieldDraft, FieldShape, OptionDraft } from './fields.ts'
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
})

describe('fieldsDiffer', () => {
  /** The stored shape is the draft's, so a round trip compares equal. */
  function stored(fields: readonly FieldDraft[]): FieldShape[] {
    return fields.map((field) => ({ ...field, options: storedOptions(field.options) }))
  }

  const list = [name, email]

  it('sees no change in a list that was sent back unaltered', () => {
    expect(fieldsDiffer(stored(list), list)).toBe(false)
  })

  it('sees a field added', () => {
    expect(fieldsDiffer(stored(list), [...list, draft({ label: 'Message', type: 'textarea', mapTo: 'submission' })])).toBe(true)
  })

  it('sees a field removed', () => {
    expect(fieldsDiffer(stored(list), [email])).toBe(true)
  })

  it('sees a label edited', () => {
    expect(fieldsDiffer(stored(list), [draft({ label: 'Full name', type: 'text', mapTo: 'person.name' }), email])).toBe(true)
  })

  /** Order is what the embed renders, so reordering is a change even though nothing else moved. */
  it('sees a reorder', () => {
    expect(fieldsDiffer(stored(list), [email, name])).toBe(true)
  })

  it('sees an option label edited', () => {
    const select = (value: string): FieldDraft =>
      draft({
        label: 'Size',
        type: 'select',
        mapTo: 'submission',
        options: [{ key: 'small', value, valueType: 'string' }],
      })

    expect(fieldsDiffer(stored([email, select('1-10')]), [email, select('1 to 10')])).toBe(true)
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
