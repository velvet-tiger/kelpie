import {
  FORM_FIELD_TYPES,
  isCompatibleFormFieldType,
  isKnownMapTarget,
  isRepeatableMapTarget,
  PERSON_CONSENT_TARGET,
  PERSON_EMAIL_TARGET,
  suggestedFormFieldType,
} from '@kelpie/schemas'
import type {
  CustomFieldDefinitionRef,
  Form,
  FormFieldInput,
  FormFieldMapTarget,
  FormFieldType,
} from '@kelpie/schemas'

import { CRM_FIELD_PRESETS, NEW_SELECT_OPTIONS } from './template.ts'

/**
 * Editing a form's field list, as pure functions over an array.
 *
 * A write replaces the whole list, so the builder holds one and hands it back;
 * these are the transformations it applies. No React and no fetching here, which
 * is what makes the rules that keep a list valid testable on their own.
 *
 * The rules mirror `findFieldProblems` on the server. That is not duplication
 * for its own sake: the server is the authority and answers `422`, and these
 * keep the builder from constructing a list it already knows will be refused.
 */

/** A field being edited, with the identity the list uses to address it. */
export interface EditableField extends FormFieldInput {
  /** The stored field id, or a local one for a field not yet saved. */
  readonly id: string
}

export const FIELD_TYPE_OPTIONS = FORM_FIELD_TYPES.map((type) => ({ value: type, label: type }))

export interface FindProblemsOptions {
  readonly customFieldDefinitions?: readonly CustomFieldDefinitionRef[]
}

/** Reads a saved form into the shape the builder edits. */
export function toEditableFields(form: Form): EditableField[] {
  return form.fields.map((field) => ({
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required,
    mapTo: field.mapTo,
    options: field.options.map((option) => ({ ...option })),
    placeholder: field.placeholder,
    statement: field.statement,
    consentPurposeIds: [...field.consentPurposeIds],
    consentPurposeLabels: { ...field.consentPurposeLabels },
  }))
}

/** Strips the local ids back off. Ids are assigned server-side on every write. */
export function toFieldInputs(fields: readonly EditableField[]): FormFieldInput[] {
  return fields.map(({ id: _id, ...field }) => field)
}

/**
 * Whether an edited list differs from what is saved.
 *
 * Mirrors the server's own comparison so the Save button can be honest about
 * whether there is anything to save. Order counts: it is the order the embed
 * renders.
 */
export function fieldsChanged(form: Form, fields: readonly EditableField[]): boolean {
  return JSON.stringify(toFieldInputs(toEditableFields(form))) !== JSON.stringify(toFieldInputs(fields))
}

function withoutOptions(field: EditableField): EditableField {
  const { options: _options, ...rest } = field

  return { ...rest, options: [] }
}

/**
 * Applies one edit to one field, keeping the field internally consistent.
 *
 * A select gets starter options the moment it becomes one, and loses them the
 * moment it stops, because the server refuses both of the states in between. The
 * mockup's builder does the same, for the same reason a reader would expect it:
 * choosing "select" and being shown an empty dropdown is not a state anybody
 * meant to create.
 */
export function editField(
  fields: readonly EditableField[],
  id: string,
  change: Partial<FormFieldInput>,
): EditableField[] {
  return fields.map((field) => {
    if (field.id !== id) {
      // Only one field may carry a CRM target, so taking one releases it
      // wherever it was. `submission` and `person.consent` are the targets
      // that may repeat — consent's uniqueness is per purpose, not per
      // target, and is enforced when the purpose is picked.
      return change.mapTo !== undefined &&
        !isRepeatableMapTarget(change.mapTo) &&
        field.mapTo === change.mapTo
        ? { ...field, mapTo: 'submission' }
        : field
    }

    const next: EditableField = { ...field, ...change }

    // A consent or notice field must map to person.consent; anything else
    // clears any lingering purpose list.
    const isConsentLike = next.type === 'consent' || next.type === 'notice'
    if (isConsentLike && next.mapTo !== PERSON_CONSENT_TARGET) {
      return { ...withoutOptions(next), mapTo: PERSON_CONSENT_TARGET }
    }
    if (next.mapTo === PERSON_CONSENT_TARGET && !isConsentLike) {
      return { ...withoutOptions(next), type: 'consent' }
    }
    if (!isConsentLike && (next.consentPurposeIds ?? []).length > 0) {
      return withoutOptions({ ...next, consentPurposeIds: [] })
    }

    if (next.type !== 'select') {
      return withoutOptions(next)
    }

    return (next.options ?? []).length === 0 ? { ...next, options: NEW_SELECT_OPTIONS } : next
  })
}

/** Inserts a field after `afterId`, or at the end when there is nothing to follow. */
export function insertField(
  fields: readonly EditableField[],
  field: EditableField,
  afterId: string | null,
): EditableField[] {
  const index = afterId === null ? -1 : fields.findIndex((existing) => existing.id === afterId)

  if (index < 0) {
    return [...fields, field]
  }

  return [...fields.slice(0, index + 1), field, ...fields.slice(index + 1)]
}

export function removeField(fields: readonly EditableField[], id: string): EditableField[] {
  return fields.filter((field) => field.id !== id)
}

/** Moves the dragged field to where it was dropped. */
export function reorderFields(
  fields: readonly EditableField[],
  activeId: string,
  overId: string,
): EditableField[] {
  const from = fields.findIndex((field) => field.id === activeId)
  const to = fields.findIndex((field) => field.id === overId)

  if (from < 0 || to < 0 || from === to) {
    return [...fields]
  }

  const next = [...fields]
  const [moved] = next.splice(from, 1)

  if (moved === undefined) {
    return [...fields]
  }

  next.splice(to, 0, moved)

  return next
}

/**
 * What the server would refuse about this list, as messages beside the field
 * they belong to.
 *
 * Keyed by field id rather than by index, because the builder renders rows and
 * an index moves when something above it is dragged.
 */
export interface FieldListProblems {
  /** Problems about the list as a whole, not about any one field. */
  readonly list: readonly string[]
  readonly byField: ReadonlyMap<string, string>
}

export function findProblems(
  fields: readonly EditableField[],
  createsDeal: boolean,
  options: FindProblemsOptions = {},
): FieldListProblems {
  const list: string[] = []
  const byField = new Map<string, string>()
  const seen = new Set<string>()
  const usedConsentPurposes = new Set<string>()
  const customFieldDefinitions = options.customFieldDefinitions ?? []

  if (!fields.some((field) => field.mapTo === PERSON_EMAIL_TARGET)) {
    list.push(`One field must map to ${PERSON_EMAIL_TARGET}, or no submission can be processed.`)
  }

  if (createsDeal && !fields.some((field) => field.mapTo.startsWith('company.'))) {
    list.push('A form that creates deals needs a company field for the deal to belong to.')
  }

  for (const field of fields) {
    if (!isKnownMapTarget(field.mapTo, customFieldDefinitions)) {
      byField.set(field.id, `Unknown map target ${field.mapTo}.`)
    } else if (
      field.mapTo !== PERSON_CONSENT_TARGET &&
      !isCompatibleFormFieldType(field.type, field.mapTo, customFieldDefinitions)
    ) {
      byField.set(field.id, `A ${field.type} field cannot map to ${field.mapTo}.`)
    }

    if (field.mapTo === PERSON_CONSENT_TARGET) {
      const purposes = field.consentPurposeIds ?? []
      if (field.type === 'notice' && (field.statement ?? '').trim().length === 0) {
        byField.set(field.id, 'A notice field needs a statement.')
      }
      if (purposes.length === 0) {
        byField.set(
          field.id,
          field.type === 'notice'
            ? 'Pick at least one purpose this notice grants implicitly.'
            : 'Pick at least one consent purpose this field offers.',
        )
      } else {
        const localSeen = new Set<string>()
        for (const purposeId of purposes) {
          if (localSeen.has(purposeId)) {
            byField.set(field.id, 'This field lists a purpose twice.')
            break
          }
          localSeen.add(purposeId)
          if (usedConsentPurposes.has(purposeId)) {
            byField.set(field.id, 'Another consent field already offers this purpose.')
          } else {
            usedConsentPurposes.add(purposeId)
          }
        }
      }
    } else if (!isRepeatableMapTarget(field.mapTo)) {
      if (seen.has(field.mapTo)) {
        byField.set(field.id, `Another field already maps to ${field.mapTo}.`)
      }

      seen.add(field.mapTo)
    }

    if (field.type === 'select' && (field.options ?? []).length === 0) {
      byField.set(field.id, 'A select needs at least one option.')
    }

    const keys = (field.options ?? []).map((option) => option.key)

    if (new Set(keys).size !== keys.length) {
      byField.set(field.id, 'Two options share a key.')
    }
  }

  return { list, byField }
}

/** True when the list is one the API will accept. */
export function isUsable(problems: FieldListProblems): boolean {
  return problems.list.length === 0 && problems.byField.size === 0
}

/** The types a mapping can sensibly render as. */
export function typeForTarget(
  target: FormFieldMapTarget,
  current: FormFieldType,
  customFieldDefinitions: readonly CustomFieldDefinitionRef[] = [],
): FormFieldType {
  return suggestedFormFieldType(target, customFieldDefinitions, current)
}

/**
 * The CRM presets whose mapping no current field carries: what "Add field" may
 * still offer. A CRM target may appear once, so a preset leaves the menu the
 * moment a field takes its target and returns when that field releases it.
 */
export function unusedCrmPresets(fields: readonly EditableField[]): readonly FormFieldInput[] {
  const used = new Set(fields.map((field) => field.mapTo))

  return CRM_FIELD_PRESETS.filter((preset) => !used.has(preset.mapTo))
}
