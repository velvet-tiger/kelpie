import { composeName } from '@kelpie/schemas'

import type { ErrorDetail } from '../../lib/errors.ts'
import { normaliseDomain, normaliseEmail } from '../../lib/normalisation.ts'
import type { FormFieldRecord } from './repository.ts'
import { PERSON_EMAIL_TARGET } from './schema.ts'
import type { FormFieldMapTarget } from './schema.ts'

/**
 * The submit rules from `forms.md` that need no database: what an answer map
 * means, and whether it is one this form accepts.
 *
 * Pure on purpose. These are the rules a reader of `forms.md` would check by
 * hand, they have no clock and no workspace, and they are the half of a submit
 * worth a unit test. `submission.ts` holds the half that writes rows.
 */

/** An answer map as it arrives: field id to the text or option key given. */
export type Answers = Readonly<Record<string, string>>

/** Answers keyed by what they write rather than by which field carried them. */
export type MappedAnswers = Partial<Record<FormFieldMapTarget, string>>

/**
 * What a submit will write, once the blanks are known.
 *
 * Every value here is already trimmed and normalised. A field the submitter left
 * blank is absent rather than empty, because "not given" and "given as nothing"
 * lead to different merges and only the first one happened.
 */
export interface SubmitIntent {
  /** Normalised. The one value a submit cannot proceed without. */
  readonly email: string
  /**
   * The name given, the one composed from the first and last name answers, or —
   * when the form asked for no name at all — the part of the address before the
   * `@`.
   */
  readonly personName: string
  /** The `person.first_name` answer only. Never split out of `personName`. */
  readonly personFirstName: string | undefined
  readonly personLastName: string | undefined
  readonly companyName: string | undefined
  /** The `company.domain` answer only. Never derived from the address; see `resolveDomain`. */
  readonly companyDomain: string | undefined
  readonly positionTitle: string | undefined
  /** Only meaningful when the form creates deals. */
  readonly dealName: string | undefined
  /** Only meaningful when the form creates opportunities. */
  readonly opportunityName: string | undefined
  /** Only meaningful when the form creates partnerships. */
  readonly partnershipName: string | undefined
  /** Only meaningful when the form creates enquiries. */
  readonly enquiryName: string | undefined
}

/** True for a consent-field answer that means "ticked". */
export function isConsentTicked(value: string | undefined): boolean {
  if (value === undefined) return false
  const trimmed = value.trim().toLowerCase()
  return trimmed === 'true' || trimmed === 'on' || trimmed === '1' || trimmed === 'yes'
}

/** One consent grant read off the answers, for the submit transaction to apply. */
export interface ConsentGrant {
  readonly fieldId: string
  readonly purposeId: string
  /** The field-level intro sentence, shown above every checkbox in the field. */
  readonly statement: string
  /**
   * The field's per-purpose text override for this purpose. Empty when the
   * field defers to the workspace purpose's own label; the submit resolves
   * that fallback with the purpose row it loads to record the activity.
   */
  readonly customLabel: string
}

/**
 * Reduces answers to one value per target.
 *
 * Blank answers are dropped, so a submitter who cleared a prefilled field does
 * not overwrite a stored value with nothing. Two fields sharing a target is
 * refused when the form is written, except for `submission`, which writes
 * nothing and so cannot collide, and `person.consent`, which is read by
 * {@link readConsentGrants} instead — a form may carry several consent boxes,
 * each granting a different purpose.
 */
export function mapAnswers(fields: readonly FormFieldRecord[], answers: Answers): MappedAnswers {
  const mapped: MappedAnswers = {}

  for (const field of fields) {
    // `person.consent` (both `consent` and `notice` types) is read separately
    // — a checkbox field by ticked ids, a notice implicitly by submission.
    if (field.mapTo === 'person.consent') continue

    const value = answers[field.id]?.trim()

    if (value === undefined || value.length === 0) {
      continue
    }

    mapped[field.mapTo as FormFieldMapTarget] = value
  }

  return mapped
}

/**
 * Every ticked purpose across every consent field on this form, in field
 * order then purpose order. A consent field's answer is a comma-separated
 * list of the purpose ids the visitor ticked; anything not on the field's
 * configured list is dropped silently — the embed offers only what the field
 * declares, so an unlisted id has to be an unusual client.
 *
 * The statement is the field's `statement` when set, else the field's label —
 * the sentence shown above the checkboxes.
 */
export function readConsentGrants(
  fields: readonly FormFieldRecord[],
  answers: Answers,
): readonly ConsentGrant[] {
  const grants: ConsentGrant[] = []
  for (const field of fields) {
    if (field.consentPurposeIds.length === 0) continue
    const statement = field.statement ?? field.label

    // A `notice` field grants every configured purpose implicitly: the
    // visitor's act of submitting the form is the consent, per the notice
    // text they read. No answer to parse.
    if (field.type === 'notice') {
      for (const purposeId of field.consentPurposeIds) {
        grants.push({
          fieldId: field.id,
          purposeId,
          statement,
          customLabel: '',
        })
      }
      continue
    }

    if (field.type !== 'consent') continue
    const ticked = parseConsentAnswer(answers[field.id])
    if (ticked.length === 0) continue
    const allowed = new Set(field.consentPurposeIds)
    for (const purposeId of ticked) {
      if (!allowed.has(purposeId)) continue
      grants.push({
        fieldId: field.id,
        purposeId,
        statement,
        customLabel: field.consentPurposeLabels[purposeId] ?? '',
      })
    }
  }
  return grants
}

/** Splits a consent field's answer into the ticked purpose ids. */
export function parseConsentAnswer(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return Array.from(new Set(parts))
}

/**
 * Everything wrong with an answer map, as `api.md` field details.
 *
 * All of it at once rather than the first problem: a form is filled in by a
 * person, and telling them about one missing field at a time is how a contact
 * form gets abandoned.
 *
 * A missing `person.email` is deliberately not reported here. It is the one
 * failure that is about the form rather than the answers, `forms.md` gives it
 * its own status, and the caller raises it before reaching this.
 */
export function findAnswerProblems(
  fields: readonly FormFieldRecord[],
  answers: Answers,
): readonly ErrorDetail[] {
  const known = new Set(fields.map((field) => field.id))
  const problems: ErrorDetail[] = []

  for (const id of Object.keys(answers)) {
    if (!known.has(id)) {
      problems.push({ field: `answers.${id}`, message: 'Unknown field' })
    }
  }

  for (const field of fields) {
    // A consent field's answer is a comma-separated list of ticked purpose
    // ids. Required means at least one must be ticked; unrequired means the
    // list may be empty. Ids not on the field's own list are silently
    // ignored on submit — the embed offers only what the field configures.
    if (field.type === 'consent') {
      const ticked = parseConsentAnswer(answers[field.id])
      if (field.required && ticked.length === 0) {
        problems.push({
          field: `answers.${field.id}`,
          message: `${field.label} needs at least one choice`,
        })
      }
      continue
    }

    // A notice field carries no answer — its consent is implicit in the
    // submission. `required` is meaningless on it. An answer sent for it is
    // silently ignored; the mapper never reads it either.
    if (field.type === 'notice') {
      continue
    }

    const value = answers[field.id]?.trim() ?? ''

    if (value.length === 0) {
      if (field.required) {
        problems.push({ field: `answers.${field.id}`, message: `${field.label} is required` })
      }

      continue
    }

    // An option's `key` is what is stored, so it is what is accepted. The
    // display `value` may change without invalidating a stored answer.
    if (field.type === 'select' && !field.options.some((option) => option.key === value)) {
      problems.push({
        field: `answers.${field.id}`,
        message: `${field.label} does not offer that choice`,
      })
    }
  }

  return problems
}

/**
 * The domain a Company is matched or created on: the `company.domain` answer,
 * and nothing else.
 *
 * The address's host is deliberately not used. An email domain is not a company
 * identifier — one company sends from several, a consumer address belongs to no
 * company at all, and two people at unrelated businesses can share one. Deriving
 * a company from it merges records that were never the same company, and the
 * merge is invisible until somebody notices two leads on one account.
 *
 * A form that wants companies matched on domain asks for the domain.
 */
function resolveDomain(mapped: MappedAnswers): string | undefined {
  const given = mapped['company.domain']

  return given === undefined ? undefined : normaliseDomain(given) ?? undefined
}

/**
 * Reads an answer map into what the submit will write.
 *
 * @returns undefined when no usable `person.email` answer was given, which is
 *   the `422` from `forms.md`. A value that is not an address at all fails the
 *   same way: it would otherwise create a person nobody can reply to.
 */
export function readIntent(mapped: MappedAnswers): SubmitIntent | undefined {
  const raw = mapped[PERSON_EMAIL_TARGET]
  const email = raw === undefined ? null : normaliseEmail(raw)

  if (email === null || !email.includes('@')) {
    return undefined
  }

  const firstName = mapped['person.first_name']
  const lastName = mapped['person.last_name']
  // A form that asks for a first and last name rather than one name box is the
  // common arrangement, so the pair composes the display name. The address's
  // local part stays the last resort it always was, for a form that asks for
  // neither.
  const composed = composeName({ firstName, lastName })

  return {
    email,
    personName:
      mapped['person.name'] ??
      (composed.length > 0 ? composed : undefined) ??
      email.split('@')[0] ??
      email,
    personFirstName: firstName,
    personLastName: lastName,
    companyName: mapped['company.name'],
    companyDomain: resolveDomain(mapped),
    positionTitle: mapped['position.title'],
    dealName: mapped['deal.name'],
    opportunityName: mapped['opportunity.name'],
    partnershipName: mapped['partnership.name'],
    enquiryName: mapped['enquiry.name'],
  }
}

/**
 * The merge rule for every field a submit touches: fill a blank, never overwrite.
 *
 * A form is filled in by whoever happens to be at the keyboard, and a CRM record
 * carries what the team has since learned. An inbound "Alex" must not replace
 * "Alex Rivera", so the stored value wins whenever there is one.
 *
 * @returns undefined when nothing should be written, which keeps the field out
 *   of the update and off the `changedFields` of the event.
 */
export function fillBlank(stored: string | null, inbound: string | undefined): string | undefined {
  if (inbound === undefined || inbound.length === 0) {
    return undefined
  }

  return stored === null || stored.trim().length === 0 ? inbound : undefined
}

/** What a new Company is called when the answers named a domain and no name. */
export function companyNameFrom(intent: SubmitIntent): string | undefined {
  return intent.companyName ?? intent.companyDomain
}

/**
 * Expands `{{company.name}}` and `{{person.name}}` in a create-trigger name
 * template. Shared by the deal, opportunity, and partnership triggers.
 *
 * The fallbacks are the mockup's: a template is written once by an admin and
 * then run against whatever arrives, so a submission with no company name must
 * still produce a record with a name somebody can read on a board.
 */
export function expandNameTemplate(
  template: string,
  values: { readonly companyName: string; readonly personName: string },
): string {
  return template
    .replaceAll('{{company.name}}', values.companyName.length > 0 ? values.companyName : 'Website lead')
    .replaceAll('{{person.name}}', values.personName.length > 0 ? values.personName : 'Lead')
}

/**
 * The union merge for a form's tag actions. The stored order is preserved and
 * new tags land at the end, so the timeline reads oldest-first. Never removes
 * a tag a human set: `forms.md` §Tags is explicit on that.
 *
 * @returns The merged list, and `changed` = true when at least one new tag
 *   landed. The caller uses `changed` to decide whether to emit an update
 *   event, since a no-op merge should not publish `*.updated`.
 */
export function mergeTags(
  stored: readonly string[],
  inbound: readonly string[],
): { readonly next: readonly string[]; readonly changed: boolean } {
  const known = new Set(stored)
  const additions: string[] = []

  for (const tag of inbound) {
    const trimmed = tag.trim()

    if (trimmed.length === 0 || known.has(trimmed)) {
      continue
    }

    known.add(trimmed)
    additions.push(trimmed)
  }

  if (additions.length === 0) {
    return { next: stored, changed: false }
  }

  return { next: [...stored, ...additions], changed: true }
}

/** How far ahead a deal created by a form is expected to close (`forms.md` rule 6). */
export const DEAL_CLOSE_HORIZON_DAYS = 30

/** `YYYY-MM-DD`, `days` after `from`. Date-only, per `api.md`. */
export function expectedCloseFrom(from: Date, days: number): string {
  const due = new Date(from.getTime())

  due.setUTCDate(due.getUTCDate() + days)

  return due.toISOString().slice(0, 10)
}

/**
 * The first three answers, as `Label: value`, for the activity detail line.
 *
 * Three because the timeline renders one line and a contact form's first
 * answers are the ones that say who arrived. The rest is on the submission.
 */
export function describeAnswers(fields: readonly FormFieldRecord[], answers: Answers): string | null {
  const parts = fields
    .map((field) => ({ label: field.label, value: answers[field.id]?.trim() ?? '' }))
    .filter((entry) => entry.value.length > 0)
    .slice(0, 3)
    .map((entry) => `${entry.label}: ${entry.value}`)

  return parts.length === 0 ? null : parts.join(' · ')
}
