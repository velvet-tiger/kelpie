import { fillFormEmailTemplate, formFieldDisplayLabel } from '@kelpie/schemas'
import type { FormEmailRecipient } from '@kelpie/schemas'

import { parseConsentAnswer } from './mapping.ts'
import type { Answers } from './mapping.ts'
import type { FormFieldRecord } from './repository.ts'

/**
 * Building the text of a form email: the placeholder values, the answer
 * lines, the subject line. Pure, so the rules are tested without a database;
 * `emailJob.ts` loads what these need and sends the result.
 */

/** Everything a template placeholder can name, already formatted as text. */
export interface FormEmailValues {
  readonly formName: string
  readonly formTitle: string
  readonly workspaceName: string
  readonly submittedAt: string
  readonly personEmail: string | undefined
  readonly personName: string | undefined
  readonly companyName: string | undefined
  readonly answers: string
}

/** The value of one placeholder, by the name between the braces. */
export function placeholderValue(values: FormEmailValues, name: string): string | undefined {
  switch (name) {
    case 'form.name':
      return values.formName
    case 'form.title':
      return values.formTitle
    case 'workspace.name':
      return values.workspaceName
    case 'submitted_at':
      return values.submittedAt
    case 'person.email':
      return values.personEmail
    case 'person.name':
      return values.personName
    case 'company.name':
      return values.companyName
    case 'answers':
      return values.answers
    default:
      return undefined
  }
}

/**
 * Fills a template. Every placeholder a template holds was checked when the
 * form was written, and the auto-reply's check refused the ones carrying
 * visitor text, so no scope check is needed here.
 */
export function fillTemplate(template: string, values: FormEmailValues): string {
  return fillFormEmailTemplate(template, (name) => placeholderValue(values, name))
}

/**
 * A subject is one line. A line break in a header would start a new header,
 * so every run of whitespace becomes one space. Long subjects are cut, because
 * a filled placeholder can be long even when the template is short.
 */
export function subjectLine(filled: string): string {
  const flat = filled.replace(/\s+/gu, ' ').trim()

  return flat.length > 250 ? `${flat.slice(0, 249)}…` : flat
}

/** The display names a consent or list answer's ids resolve to. */
export interface AnswerLabelSources {
  /** Consent purpose id → the purpose's label. */
  readonly purposes: ReadonlyMap<string, string>
  /** List id → the list's name. */
  readonly lists: ReadonlyMap<string, string>
}

/**
 * Every answer as a `Label: value` line, in field order.
 *
 * A select shows the option's display value rather than its key. A consent or
 * list field shows the text beside each ticked box: the field's own override,
 * else the purpose's label or the list's name. A `notice` field has no answer.
 * An empty answer has no line. An answer whose field has since been deleted
 * has no line either: its label is gone, and the reader has the submission
 * link for the full record.
 */
export function formatAnswerLines(
  fields: readonly FormFieldRecord[],
  answers: Answers,
  sources: AnswerLabelSources,
): string {
  return fields
    .map((field) => ({ label: formFieldDisplayLabel(field), value: answerText(field, answers[field.id], sources) }))
    .filter((entry) => entry.value.length > 0)
    .map((entry) => `${entry.label}: ${entry.value}`)
    .join('\n')
}

function answerText(
  field: FormFieldRecord,
  raw: string | undefined,
  sources: AnswerLabelSources,
): string {
  const answer = raw?.trim() ?? ''

  if (answer.length === 0 || field.type === 'notice') {
    return ''
  }

  if (field.type === 'select') {
    return field.options.find((option) => option.key === answer)?.value ?? answer
  }

  if (field.type === 'consent') {
    return parseConsentAnswer(answer)
      .map((id) => field.consentPurposeLabels[id] ?? sources.purposes.get(id) ?? id)
      .join(', ')
  }

  if (field.type === 'list') {
    return parseConsentAnswer(answer)
      .map((id) => field.listLabels[id] ?? sources.lists.get(id) ?? id)
      .join(', ')
  }

  return answer
}

/**
 * The submit time in the workspace's timezone, to the minute, with the zone
 * named so a reader in another one is not misled: `2026-09-30 14:05 (Australia/Sydney)`.
 */
export function formatSubmittedAt(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? ''

  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (${timezone})`
}

/** The start of the UTC day `at` falls in: the daily auto-reply limit resets there. */
export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** A provider's error text, short enough to store and show on a submission. */
export function shortDetail(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()

  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat
}

/** The two Reply-To columns as one recipient, or null when neither is set. */
export function replyToFrom(
  memberId: string | null,
  address: string | null,
): FormEmailRecipient | null {
  if (memberId !== null) {
    return { kind: 'member', memberId }
  }

  return address === null ? null : { kind: 'address', address }
}
