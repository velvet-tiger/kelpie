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
  /** The name given, or the part of the address before the `@` when none was. */
  readonly personName: string
  readonly companyName: string | undefined
  /** The `company.domain` answer only. Never derived from the address; see `resolveDomain`. */
  readonly companyDomain: string | undefined
  readonly positionTitle: string | undefined
  /** Only meaningful when the form creates deals. */
  readonly dealName: string | undefined
}

/**
 * Reduces answers to one value per target.
 *
 * Blank answers are dropped, so a submitter who cleared a prefilled field does
 * not overwrite a stored value with nothing. Two fields sharing a target is
 * refused when the form is written, except for `submission`, which writes
 * nothing and so cannot collide.
 */
export function mapAnswers(fields: readonly FormFieldRecord[], answers: Answers): MappedAnswers {
  const mapped: MappedAnswers = {}

  for (const field of fields) {
    const value = answers[field.id]?.trim()

    if (value === undefined || value.length === 0) {
      continue
    }

    mapped[field.mapTo as FormFieldMapTarget] = value
  }

  return mapped
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

  return {
    email,
    personName: mapped['person.name'] ?? email.split('@')[0] ?? email,
    companyName: mapped['company.name'],
    companyDomain: resolveDomain(mapped),
    positionTitle: mapped['position.title'],
    dealName: mapped['deal.name'],
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
 * Expands `{{company.name}}` and `{{person.name}}` in a deal name template.
 *
 * The fallbacks are the mockup's: a template is written once by an admin and
 * then run against whatever arrives, so a submission with no company name must
 * still produce a deal with a name somebody can read on a board.
 */
export function expandDealNameTemplate(
  template: string,
  values: { readonly companyName: string; readonly personName: string },
): string {
  return template
    .replaceAll('{{company.name}}', values.companyName.length > 0 ? values.companyName : 'Website lead')
    .replaceAll('{{person.name}}', values.personName.length > 0 ? values.personName : 'Lead')
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
