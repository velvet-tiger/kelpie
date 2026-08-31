import { FORM_FIELD_MAP_TARGETS } from '@kelpie/schemas'
import type { Form } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import {
  editField,
  fieldsChanged,
  findProblems,
  insertField,
  isUsable,
  removeField,
  reorderFields,
  toEditableFields,
  toFieldInputs,
  typeForTarget,
  unusedCrmPresets,
} from './fieldList.ts'
import type { EditableField } from './fieldList.ts'
import { CRM_FIELD_PRESETS, SUBMISSION_FIELD_PRESETS } from './template.ts'

/**
 * The field builder's rules, without React.
 *
 * These decide what the builder sends and what it refuses to send, so they are
 * worth pinning on their own. The server is still the authority: everything here
 * mirrors `findFieldProblems` so the builder does not construct a list it
 * already knows will come back a `422`.
 */

function field(overrides: Partial<EditableField> = {}): EditableField {
  return {
    id: 'ff_email',
    label: 'Email',
    type: 'email',
    required: true,
    mapTo: 'person.email',
    options: [],
    placeholder: null,
    consentPurposeIds: [],
    consentPurposeLabels: {},
    ...overrides,
  }
}

const email = field()
const name = field({ id: 'ff_name', label: 'Name', type: 'text', mapTo: 'person.name' })
const company = field({ id: 'ff_co', label: 'Company', type: 'text', mapTo: 'company.name' })

function form(fields: readonly EditableField[]): Form {
  const stamp = new Date('2026-08-04T00:00:00.000Z')

  return {
    id: 'form_1',
    name: 'Website contact',
    title: 'Website contact',
    description: null,
    status: 'active',
    fields: fields.map((entry, index) => ({
      id: entry.id,
      label: entry.label,
      type: entry.type,
      required: entry.required ?? false,
      mapTo: entry.mapTo,
      options: (entry.options ?? []).map((option) => ({
        key: option.key,
        value: option.value,
        valueType: option.valueType ?? 'string',
      })),
      placeholder: entry.placeholder ?? null,
      statement: null,
      consentPurposeIds: [],
    consentPurposeLabels: {},
      sortOrder: index,
    })),
    thankYouMessage: 'Thanks.',
    createDeal: false,
    dealStageId: null,
    dealNameTemplate: null,
    createOpportunity: false,
    opportunityKind: null,
    opportunityStageId: null,
    opportunityNameTemplate: null,
    opportunityOwnerId: null,
    createPartnership: false,
    partnershipKind: null,
    partnershipStageId: null,
    partnershipNameTemplate: null,
    partnershipOwnerId: null,
    createEnquiry: false,
    enquirySource: null,
    enquiryStageId: null,
    enquiryNameTemplate: null,
    enquiryOwnerId: null,
    personTags: [],
    companyTags: [],
    listIds: [],
    attachTargets: [],
    publicKey: 'pk_test',
    createdAt: stamp,
    updatedAt: stamp,
  }
}

describe('toFieldInputs', () => {
  it('drops the ids, because the server assigns them on every write', () => {
    expect(toFieldInputs([email])[0]).not.toHaveProperty('id')
  })
})

describe('fieldsChanged', () => {
  it('sees nothing to save in an untouched list', () => {
    const saved = form([name, email])

    expect(fieldsChanged(saved, toEditableFields(saved))).toBe(false)
  })

  it('sees a label edit', () => {
    const saved = form([name, email])
    const edited = editField(toEditableFields(saved), 'ff_name', { label: 'Full name' })

    expect(fieldsChanged(saved, edited)).toBe(true)
  })

  /** Order is what the embed renders, so a drag alone is a change worth saving. */
  it('sees a reorder', () => {
    const saved = form([name, email])
    const moved = reorderFields(toEditableFields(saved), 'ff_email', 'ff_name')

    expect(fieldsChanged(saved, moved)).toBe(true)
  })
})

describe('editField', () => {
  it('changes only the field named', () => {
    const edited = editField([name, email], 'ff_name', { label: 'Full name' })

    expect(edited.map((entry) => entry.label)).toEqual(['Full name', 'Email'])
  })

  /** Only one field may carry a CRM target, so taking one has to release it. */
  it('releases a target the moment another field claims it', () => {
    const edited = editField([name, email], 'ff_email', { mapTo: 'person.name' })

    expect(edited.map((entry) => entry.mapTo)).toEqual(['submission', 'person.name'])
  })

  it('leaves other submission-only fields alone, because that target repeats', () => {
    const message = field({ id: 'ff_msg', type: 'textarea', mapTo: 'submission' })
    const edited = editField([message, email], 'ff_email', { mapTo: 'submission' })

    expect(edited.map((entry) => entry.mapTo)).toEqual(['submission', 'submission'])
  })

  it('gives a field starter options the moment it becomes a select', () => {
    const edited = editField([email], 'ff_email', { type: 'select' })

    expect(edited[0]?.options).toHaveLength(2)
  })

  it('takes the options away again when it stops being one', () => {
    const asSelect = editField([email], 'ff_email', { type: 'select' })
    const asText = editField(asSelect, 'ff_email', { type: 'text' })

    expect(asText[0]?.options).toEqual([])
  })
})

describe('insertField', () => {
  it('adds below the field it was asked to follow', () => {
    const added = insertField([name, email], field({ id: 'new-1', label: 'Phone' }), 'ff_name')

    expect(added.map((entry) => entry.label)).toEqual(['Name', 'Phone', 'Email'])
  })

  it('adds at the end when following nothing', () => {
    const added = insertField([name, email], field({ id: 'new-1', label: 'Phone' }), null)

    expect(added.map((entry) => entry.label)).toEqual(['Name', 'Email', 'Phone'])
  })
})

describe('removeField', () => {
  it('takes one out and leaves the rest in order', () => {
    expect(removeField([name, email, company], 'ff_email').map((entry) => entry.id)).toEqual([
      'ff_name',
      'ff_co',
    ])
  })
})

describe('reorderFields', () => {
  it('moves the dragged field to where it was dropped', () => {
    expect(reorderFields([name, email, company], 'ff_co', 'ff_name').map((entry) => entry.id)).toEqual(
      ['ff_co', 'ff_name', 'ff_email'],
    )
  })

  it('does nothing when a field is dropped on itself', () => {
    expect(reorderFields([name, email], 'ff_name', 'ff_name').map((entry) => entry.id)).toEqual([
      'ff_name',
      'ff_email',
    ])
  })
})

describe('findProblems', () => {
  it('accepts the contact template', () => {
    expect(isUsable(findProblems([name, email, company], false))).toBe(true)
  })

  it('reports a list with no email mapping', () => {
    const problems = findProblems([name], false)

    expect(problems.list).toHaveLength(1)
    expect(isUsable(problems)).toBe(false)
  })

  /** A deal belongs to a company, and the address is never used to invent one. */
  it('reports a deal-creating form with no company field', () => {
    const problems = findProblems([name, email], true)

    expect(problems.list.join(' ')).toContain('company field')
  })

  it('accepts a deal-creating form once a company field is there', () => {
    expect(isUsable(findProblems([name, email, company], true))).toBe(true)
  })

  it('marks the second field claiming a target, not the first', () => {
    const duplicate = field({ id: 'ff_other', type: 'text', mapTo: 'person.name' })
    const problems = findProblems([name, email, duplicate], false)

    expect([...problems.byField.keys()]).toEqual(['ff_other'])
  })

  it('marks a select with no options', () => {
    const empty = field({ id: 'ff_size', type: 'select', mapTo: 'submission', options: [] })

    expect(findProblems([email, empty], false).byField.get('ff_size')).toContain('at least one option')
  })

  it('marks two options sharing a key', () => {
    const clashing = field({
      id: 'ff_size',
      type: 'select',
      mapTo: 'submission',
      options: [
        { key: 'small', value: '1-10', valueType: 'string' },
        { key: 'small', value: '11-50', valueType: 'string' },
      ],
    })

    expect(findProblems([email, clashing], false).byField.get('ff_size')).toContain('share a key')
  })
})

describe('unusedCrmPresets', () => {
  /**
   * The menu must never lack a target the schema knows, or it becomes
   * unreachable. `person.consent` is offered through `SUBMISSION_FIELD_PRESETS`
   * because it repeats per purpose rather than per form.
   */
  it('covers every CRM target when the list is empty', () => {
    const offered = unusedCrmPresets([]).map((preset) => preset.mapTo)
    const crmTargets = FORM_FIELD_MAP_TARGETS.filter(
      (target) => target !== 'submission' && target !== 'person.consent',
    )

    expect([...offered].sort()).toEqual([...crmTargets].sort())
  })

  it('hides a target a field already carries', () => {
    const offered = unusedCrmPresets([email]).map((preset) => preset.mapTo)

    expect(offered).not.toContain('person.email')
    expect(offered).toContain('person.name')
  })

  /**
   * A preset must be addable as-is: no per-field problem the moment it lands.
   * The consent and notice presets are exempt — the purpose is picked in the
   * settings panel after the field is added, and without a workspace to read
   * purposes from there is nothing to auto-fill.
   */
  it('offers only presets the server would accept', () => {
    const presets = [...CRM_FIELD_PRESETS, ...SUBMISSION_FIELD_PRESETS.map((entry) => entry.field)]

    for (const [index, preset] of presets.entries()) {
      if (preset.type === 'consent' || preset.type === 'notice') continue
      const added = insertField([], field({ ...preset, id: `new-${String(index)}` }), null)

      expect(findProblems(added, false).byField.size).toBe(0)
    }
  })
})

describe('typeForTarget', () => {
  it('forces an email input for the address field', () => {
    expect(typeForTarget('person.email', 'text')).toBe('email')
  })

  it('suggests textarea for long-text targets', () => {
    expect(typeForTarget('person.summary', 'text')).toBe('textarea')
  })
})
