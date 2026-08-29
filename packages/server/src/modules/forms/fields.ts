import type { ErrorDetail } from '../../lib/errors.ts'
import type { StoredFormFieldOption } from './schema.ts'
import { PERSON_EMAIL_TARGET } from './schema.ts'
import type { FormFieldMapTarget, FormFieldType, FormOptionValueType } from './schema.ts'

/**
 * What a form's field list has to satisfy before it is stored.
 *
 * Per-form rules, which is why they are not check constraints: "at most one
 * `person.email` mapping" is a statement about a set of rows, and the database
 * has nowhere to hang it. Pure, so the rules that decide whether a form can ever
 * process a submission are testable without one.
 */

/** A field as a write request carries it: no id, no position, both derived. */
export interface FieldDraft {
  readonly label: string
  readonly type: FormFieldType
  readonly required: boolean
  readonly mapTo: FormFieldMapTarget
  readonly options: readonly OptionDraft[]
  readonly placeholder: string | null
}

export interface OptionDraft {
  readonly key: string
  readonly value: string
  readonly valueType: FormOptionValueType
}

/**
 * Targets a form may map more than one field to.
 *
 * Only `submission`, which writes no CRM field and so has nothing to collide
 * over. Two fields both mapped to `person.name` would leave the submit picking
 * one of them by field order, which is not a decision a form author made.
 */
const REPEATABLE_TARGETS: ReadonlySet<string> = new Set(['submission'])

/** The two targets that establish a company for a submit to attach a Deal to. */
const COMPANY_TARGETS: readonly string[] = ['company.name', 'company.domain']

/**
 * Everything wrong with a field list, as `api.md` field details.
 *
 * All of it at once: a field builder sends the whole list, so reporting one
 * problem per request would make fixing three of them three round trips.
 *
 * @param fields In the order they were sent, which becomes their order on screen.
 * @param createsDeal Whether the form the list belongs to creates Deals. A Deal
 *   belongs to a Company, and a submit only resolves one from a `company.name`
 *   or `company.domain` answer, so a deal-creating form without either would
 *   quietly never create a deal. Refused here rather than discovered later by
 *   somebody wondering where their inbound pipeline went.
 * @param createsPartnership Same rule for partnerships: a Partnership belongs
 *   to a Company. Opportunities are exempt because `opportunities.company_id`
 *   is nullable — a form that creates an opportunity without resolving a
 *   company creates an opportunity without one, which is a valid state.
 */
export function findFieldProblems(
  fields: readonly FieldShape[],
  createsDeal: boolean,
  createsPartnership = false,
): readonly ErrorDetail[] {
  const problems: ErrorDetail[] = []
  const seenTargets = new Set<string>()

  if (!fields.some((field) => field.mapTo === PERSON_EMAIL_TARGET)) {
    problems.push({
      field: 'fields',
      message: `A form needs exactly one field mapped to ${PERSON_EMAIL_TARGET}`,
    })
  }

  const hasCompanyField = fields.some((field) => COMPANY_TARGETS.includes(field.mapTo))

  if (createsDeal && !hasCompanyField) {
    problems.push({
      field: 'fields',
      message: `A form that creates deals needs a field mapped to ${COMPANY_TARGETS.join(' or ')}`,
    })
  }

  if (createsPartnership && !hasCompanyField) {
    problems.push({
      field: 'fields',
      message: `A form that creates partnerships needs a field mapped to ${COMPANY_TARGETS.join(' or ')}`,
    })
  }

  for (const [index, field] of fields.entries()) {
    const at = `fields.${String(index)}`

    if (!REPEATABLE_TARGETS.has(field.mapTo)) {
      if (seenTargets.has(field.mapTo)) {
        problems.push({ field: `${at}.map_to`, message: `Another field already maps to ${field.mapTo}` })
      }

      seenTargets.add(field.mapTo)
    }

    problems.push(...findOptionProblems(field, at))
  }

  return problems
}

/** A select needs choices; everything else must not carry any. */
function findOptionProblems(field: FieldShape, at: string): readonly ErrorDetail[] {
  if (field.type !== 'select') {
    return field.options.length === 0
      ? []
      : [{ field: `${at}.options`, message: `A ${field.type} field has no options` }]
  }

  if (field.options.length === 0) {
    return [{ field: `${at}.options`, message: 'A select field needs at least one option' }]
  }

  const problems: ErrorDetail[] = []
  const seenKeys = new Set<string>()

  for (const [index, option] of field.options.entries()) {
    // The key is what a stored answer holds, so a duplicate would make an
    // existing submission ambiguous about which choice was made.
    if (seenKeys.has(option.key)) {
      problems.push({
        field: `${at}.options.${String(index)}.key`,
        message: `Another option already uses "${option.key}"`,
      })
    }

    seenKeys.add(option.key)
  }

  return problems
}

/** A field's options as they are stored. Structurally the drafts, narrowed to the stored type. */
export function storedOptions(
  options: readonly OptionDraft[],
): readonly StoredFormFieldOption[] {
  return options.map((option) => ({
    key: option.key,
    value: option.value,
    valueType: option.valueType,
  }))
}

/**
 * A field with its ids and tenancy stripped: everything a write can change.
 *
 * Both a stored row and an inbound `FieldDraft` satisfy this, which is what lets
 * one comparison and one rule set serve both sides. `type` and `mapTo` are
 * `string` rather than their unions because that is what a `text` column reads
 * back as; narrowing them here would mean asserting a value that is only ever
 * tested for equality, and the check constraint is what guarantees the column
 * holds one of the set.
 */
export interface FieldShape {
  readonly label: string
  readonly type: string
  readonly required: boolean
  readonly mapTo: string
  readonly options: readonly StoredFormFieldOption[]
  readonly placeholder: string | null
}

/**
 * Whether a submitted field list differs from the stored one.
 *
 * A write replaces the whole list, so without this a client resending what it
 * already had would delete and reinsert every row, move every id, and publish a
 * `record.updated` that no consumer can act on. Order counts: it is the order
 * the embed renders, and reordering is the one edit that changes nothing else.
 *
 * @param stored In `sort_order`, which is the order the repository returns.
 */
export function fieldsDiffer(
  stored: readonly FieldShape[],
  drafts: readonly FieldDraft[],
): boolean {
  if (stored.length !== drafts.length) {
    return true
  }

  return stored.some((field, index) => {
    const draft = drafts[index]

    return (
      draft === undefined ||
      field.label !== draft.label ||
      field.type !== draft.type ||
      field.required !== draft.required ||
      field.mapTo !== draft.mapTo ||
      field.placeholder !== draft.placeholder ||
      optionsDiffer(field.options, draft.options)
    )
  })
}

function optionsDiffer(
  stored: readonly StoredFormFieldOption[],
  drafts: readonly OptionDraft[],
): boolean {
  if (stored.length !== drafts.length) {
    return true
  }

  return stored.some((option, index) => {
    const draft = drafts[index]

    return (
      draft === undefined ||
      option.key !== draft.key ||
      option.value !== draft.value ||
      option.valueType !== draft.valueType
    )
  })
}
