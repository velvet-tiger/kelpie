import { FORM_EMAIL_KINDS } from '@kelpie/schemas'
import type {
  FormActionStatus,
  FormEmailKind,
  FormEmailRecipient,
  FormSubmissionActionEntry,
} from '@kelpie/schemas'
import { z } from 'zod'

import type { Database } from '../../lib/database.ts'
import type { EmailSender } from '../../lib/email.ts'
import { renderTextEmail } from '../../lib/emailContent.ts'
import { describeThrown } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { JobDefinition } from '../../lib/jobs.ts'
import { normaliseEmail } from '../../lib/normalisation.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { moduleCapabilityName } from '../../runtime/moduleConfig.ts'
import * as companyRepository from '../companies/repository.ts'
import * as consentPurposesRepository from '../consent-purposes/repository.ts'
import * as listsRepository from '../lists/repository.ts'
import * as peopleRepository from '../people/repository.ts'
import * as workspaceRepository from '../workspace/repository.ts'
import * as emailRepository from './emailRepository.ts'
import type { FormEmailSendRecord, FormSubmissionRow } from './emailRepository.ts'
import {
  fillTemplate,
  formatAnswerLines,
  formatSubmittedAt,
  replyToFrom,
  shortDetail,
  startOfUtcDay,
  subjectLine,
} from './emailMessages.ts'
import type { FormEmailValues } from './emailMessages.ts'
import { parseConsentAnswer } from './mapping.ts'
import * as repository from './repository.ts'
import type { FormFieldRecord, FormRecord } from './repository.ts'
import { PERSON_EMAIL_TARGET } from './schema.ts'

/**
 * `forms.send-emails`: the notification and the auto-reply a submit asked for.
 *
 * The submit adds one job inside its own transaction, so a rolled-back submit
 * sends nothing, and the visitor's `201` never waits on a mail server. The
 * job reads the form when it runs, not when the visitor submitted: an email
 * turned off in between, or a form paused or deleted, sends nothing.
 *
 * Every message tried is a row of `form_email_sends`, unique per submission,
 * kind and recipient. A retry skips every message with a `sent` row, so a
 * retry never sends one message twice. When a message fails, the job writes
 * its `action_log` entries first and then throws, so pg-boss retries it and
 * the Submissions tab shows the error in the meantime.
 */

export const SEND_FORM_EMAILS_JOB = 'forms.send-emails'

/** Which email each `action_log` entry reports on. */
export const FORM_EMAIL_ACTIONS: Readonly<Record<FormEmailKind, string>> = {
  notification: 'email_notification',
  auto_reply: 'email_auto_reply',
}

/** How far back a sent auto-reply blocks another to the same address from the same form. */
const AUTO_REPLY_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000

export const sendFormEmailsDataSchema = z.object({
  workspaceId: z.string().min(1),
  submissionId: z.string().min(1),
  /**
   * The emails that were on when the visitor submitted. One turned on later
   * is not sent for this submission; one turned off later is `skipped`.
   */
  kinds: z.array(z.enum(FORM_EMAIL_KINDS)).min(1),
})

export type SendFormEmailsData = z.infer<typeof sendFormEmailsDataSchema>

export interface FormEmailDependencies {
  readonly db: Database
  readonly email: EmailSender
  readonly createId: IdFactory
  readonly now: () => Date
  readonly appBaseUrl: string
  readonly entitlements: EntitlementRegistry
  /** Auto-replies one workspace may send in a UTC day. `FORMS_AUTO_REPLY_DAILY_LIMIT`. */
  readonly autoReplyDailyLimit: number
}

/** What one email came to, as its `action_log` entry reports it. */
interface EmailOutcome {
  readonly kind: FormEmailKind
  readonly status: FormActionStatus
  readonly detail: string
}

/** The emails the payload names, each `skipped` for the same reason. */
function allSkipped(kinds: readonly FormEmailKind[], detail: string): EmailOutcome[] {
  return kinds.map((kind) => ({ kind, status: 'skipped', detail }))
}

function toActionEntry(outcome: EmailOutcome): FormSubmissionActionEntry {
  return { action: FORM_EMAIL_ACTIONS[outcome.kind], status: outcome.status, detail: outcome.detail }
}

export function defineSendFormEmailsJob(
  dependencies: FormEmailDependencies,
): JobDefinition<SendFormEmailsData> {
  return {
    name: SEND_FORM_EMAILS_JOB,
    schema: sendFormEmailsDataSchema,
    defaults: { retryLimit: 3, retryDelay: 30, retryBackoff: true },
    handler: async ({ data }) => {
      await sendFormEmails(dependencies, data)
    },
  }
}

/**
 * Runs one job. Exported so a test can run the handler directly, without a
 * worker polling the queue.
 *
 * @throws Error when one or more messages failed, after the outcome is
 *   recorded, so the queue retries the job.
 */
export async function sendFormEmails(
  dependencies: FormEmailDependencies,
  data: SendFormEmailsData,
): Promise<void> {
  const { db } = dependencies
  const submission = await emailRepository.findSubmissionById(db, data.workspaceId, data.submissionId)

  // Deleted with its form between the submit and now. Nothing is left to
  // report to, so there is nothing to record either.
  if (submission === undefined) {
    return
  }

  const outcomes = await decideAndSend(dependencies, data, submission)

  await emailRepository.replaceEmailActionEntries(
    db,
    data.workspaceId,
    submission.id,
    Object.values(FORM_EMAIL_ACTIONS),
    outcomes.map(toActionEntry),
  )

  const failed = outcomes.filter((outcome) => outcome.status === 'error')

  if (failed.length > 0) {
    throw new Error(
      `form emails for submission ${submission.id} failed: ${failed.map((outcome) => outcome.detail).join('; ')}`,
    )
  }
}

async function decideAndSend(
  dependencies: FormEmailDependencies,
  data: SendFormEmailsData,
  submission: FormSubmissionRow,
): Promise<EmailOutcome[]> {
  const { db } = dependencies
  const form = await repository.findForm(db, data.workspaceId, submission.formId)

  if (form === undefined) {
    return allSkipped(data.kinds, 'The form was deleted before the email was sent')
  }

  const entitlement = await dependencies.entitlements.check(
    data.workspaceId,
    moduleCapabilityName('forms'),
  )

  if (entitlement.kind === 'flag' && !entitlement.granted) {
    return allSkipped(data.kinds, 'Forms is switched off for this workspace')
  }

  if (form.status === 'paused') {
    return allSkipped(data.kinds, 'The form was paused before the email was sent')
  }

  const workspace = await workspaceRepository.findWorkspace(db, data.workspaceId)

  if (workspace === undefined) {
    return allSkipped(data.kinds, 'The workspace no longer exists')
  }

  const fields = await repository.listFields(db, form.id)
  const members = await workspaceRepository.listMembers(db, data.workspaceId)
  const memberEmails = new Map(members.map((member) => [member.id, member.email]))
  const previous = await emailRepository.listEmailSends(db, submission.id)
  const values = await loadValues(dependencies, form, workspace, fields, submission)
  const submitterEmail = submitterEmailOf(fields, submission.answers) ?? values.personEmail
  const context: SendContext = { dependencies, form, submission, previous, values, memberEmails }
  const outcomes: EmailOutcome[] = []

  if (data.kinds.includes('notification')) {
    outcomes.push(await sendNotification(context, submitterEmail))
  }

  if (data.kinds.includes('auto_reply')) {
    outcomes.push(await sendAutoReply(context, submitterEmail))
  }

  return outcomes
}

interface SendContext {
  readonly dependencies: FormEmailDependencies
  readonly form: FormRecord
  readonly submission: FormSubmissionRow
  readonly previous: readonly FormEmailSendRecord[]
  readonly values: FormEmailValues
  readonly memberEmails: ReadonlyMap<string, string>
}

async function loadValues(
  dependencies: FormEmailDependencies,
  form: FormRecord,
  workspace: { readonly name: string; readonly timezone: string },
  fields: readonly FormFieldRecord[],
  submission: FormSubmissionRow,
): Promise<FormEmailValues> {
  const { db } = dependencies
  const [person, company] = await Promise.all([
    submission.personId === null
      ? Promise.resolve(undefined)
      : peopleRepository.findPerson(db, submission.workspaceId, submission.personId),
    submission.companyId === null
      ? Promise.resolve(undefined)
      : companyRepository.findCompany(db, submission.workspaceId, submission.companyId),
  ])
  const tickedIds = (type: string): string[] =>
    fields
      .filter((field) => field.type === type)
      .flatMap((field) => [...parseConsentAnswer(submission.answers[field.id])])
  const [purposes, lists] = await Promise.all([
    consentPurposesRepository.listPurposesByIds(db, submission.workspaceId, tickedIds('consent')),
    listsRepository.listListsById(db, submission.workspaceId, tickedIds('list')),
  ])

  return {
    formName: form.name,
    formTitle: form.title,
    workspaceName: workspace.name,
    submittedAt: formatSubmittedAt(submission.submittedAt, workspace.timezone),
    personEmail: person?.email ?? undefined,
    personName: person?.name ?? undefined,
    companyName: company?.name ?? undefined,
    answers: formatAnswerLines(fields, submission.answers, {
      purposes: new Map(purposes.map((purpose) => [purpose.id, purpose.label])),
      lists: new Map(lists.map((list) => [list.id, list.name])),
    }),
  }
}

/**
 * The address the visitor typed into the `person.email` field, normalised the
 * way the submit normalised it. Read from the answers rather than the Person,
 * because the Person may have been edited or deleted since.
 */
function submitterEmailOf(
  fields: readonly FormFieldRecord[],
  answers: Readonly<Record<string, string>>,
): string | undefined {
  const field = fields.find((candidate) => candidate.mapTo === PERSON_EMAIL_TARGET)
  const raw = field === undefined ? undefined : answers[field.id]

  return raw === undefined ? undefined : (normaliseEmail(raw) ?? undefined)
}

/** A recipient as an address, or undefined for a member who has left. */
function resolveRecipient(
  recipient: FormEmailRecipient,
  memberEmails: ReadonlyMap<string, string>,
): string | undefined {
  if (recipient.kind === 'address') {
    return recipient.address
  }

  const email = memberEmails.get(recipient.memberId)

  return email === undefined ? undefined : (normaliseEmail(email) ?? undefined)
}

function alreadySent(context: SendContext, kind: FormEmailKind, recipient: string): boolean {
  return context.previous.some(
    (send) => send.kind === kind && send.recipient === recipient && send.status === 'sent',
  )
}

async function record(
  context: SendContext,
  kind: FormEmailKind,
  recipient: string,
  status: 'sent' | 'skipped' | 'error',
  detail: string,
): Promise<void> {
  await emailRepository.recordEmailSend(context.dependencies.db, {
    id: context.dependencies.createId('formEmailSend'),
    workspaceId: context.submission.workspaceId,
    formId: context.form.id,
    submissionId: context.submission.id,
    kind,
    recipient,
    status,
    detail,
    createdAt: context.dependencies.now(),
  })
}

/**
 * Sends one message unless a `sent` row says an earlier try already did.
 *
 * @returns Whether the message is now sent.
 */
async function sendOnce(
  context: SendContext,
  kind: FormEmailKind,
  message: { readonly to: string; readonly subject: string; readonly body: string; readonly replyTo?: string | undefined },
  withSubmissionLink: boolean,
): Promise<{ readonly sent: boolean; readonly error?: string }> {
  if (alreadySent(context, kind, message.to)) {
    return { sent: true }
  }

  const { dependencies, form, submission } = context
  const link = new URL(`/forms/${form.id}/submissions/${submission.id}`, dependencies.appBaseUrl).toString()
  const rendered = renderTextEmail(
    {
      intro: message.body,
      ...(withSubmissionLink
        ? {
            action: {
              instructions: 'See the full submission in Kelpie.',
              buttonText: 'Open submission',
              link,
            },
          }
        : {}),
    },
    dependencies.appBaseUrl,
  )

  try {
    await dependencies.email.send({
      to: message.to,
      subject: message.subject,
      body: rendered.text,
      html: rendered.html,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    })
  } catch (error: unknown) {
    const detail = shortDetail(describeThrown(error))

    await record(context, kind, message.to, 'error', detail)

    return { sent: false, error: detail }
  }

  await record(context, kind, message.to, 'sent', '')

  return { sent: true }
}

async function sendNotification(
  context: SendContext,
  submitterEmail: string | undefined,
): Promise<EmailOutcome> {
  const { form } = context

  if (!form.notifyEmail) {
    return { kind: 'notification', status: 'skipped', detail: 'Turned off before it was sent' }
  }

  const stored = await emailRepository.listNotifyRecipients(context.dependencies.db, form.id)
  const addresses = Array.from(
    new Set(
      stored
        .map((recipient) => resolveRecipient(recipient, context.memberEmails))
        .filter((address): address is string => address !== undefined),
    ),
  )

  if (addresses.length === 0) {
    return { kind: 'notification', status: 'skipped', detail: 'No recipients' }
  }

  const subject = subjectLine(fillTemplate(form.notifySubject, context.values))
  const body = fillTemplate(form.notifyBody, context.values)
  const errors: string[] = []
  let sent = 0

  for (const to of addresses) {
    const result = await sendOnce(context, 'notification', { to, subject, body, replyTo: submitterEmail }, true)

    if (result.sent) {
      sent += 1
    } else if (result.error !== undefined) {
      errors.push(`${to}: ${result.error}`)
    }
  }

  const count = `Sent to ${String(sent)} of ${String(addresses.length)} recipients`

  return errors.length === 0
    ? { kind: 'notification', status: 'ok', detail: count }
    : { kind: 'notification', status: 'error', detail: shortDetail(`${count}. ${errors.join('; ')}`) }
}

async function sendAutoReply(
  context: SendContext,
  submitterEmail: string | undefined,
): Promise<EmailOutcome> {
  const { dependencies, form, submission } = context

  if (!form.autoReply) {
    return { kind: 'auto_reply', status: 'skipped', detail: 'Turned off before it was sent' }
  }

  if (submitterEmail === undefined) {
    return { kind: 'auto_reply', status: 'skipped', detail: 'No submitter email' }
  }

  if (!alreadySent(context, 'auto_reply', submitterEmail)) {
    const now = dependencies.now()
    const repeat = await emailRepository.autoReplySentSince(
      dependencies.db,
      form.id,
      submitterEmail,
      new Date(now.getTime() - AUTO_REPLY_REPEAT_WINDOW_MS),
      submission.id,
    )

    if (repeat) {
      const detail = 'Sent to this address in the last 24 hours'

      await record(context, 'auto_reply', submitterEmail, 'skipped', detail)

      return { kind: 'auto_reply', status: 'skipped', detail }
    }

    const today = await emailRepository.countAutoRepliesSince(
      dependencies.db,
      submission.workspaceId,
      startOfUtcDay(now),
    )

    if (today >= dependencies.autoReplyDailyLimit) {
      const detail = 'Daily auto-reply limit reached'

      await record(context, 'auto_reply', submitterEmail, 'skipped', detail)

      return { kind: 'auto_reply', status: 'skipped', detail }
    }
  }

  const replyToRecipient = replyToFrom(form.autoReplyReplyToMemberId, form.autoReplyReplyToAddress)
  const replyTo =
    replyToRecipient === null ? undefined : resolveRecipient(replyToRecipient, context.memberEmails)
  const result = await sendOnce(
    context,
    'auto_reply',
    {
      to: submitterEmail,
      subject: subjectLine(fillTemplate(form.autoReplySubject, context.values)),
      body: fillTemplate(form.autoReplyBody, context.values),
      replyTo,
    },
    false,
  )

  return result.sent
    ? { kind: 'auto_reply', status: 'ok', detail: 'Sent to the submitter' }
    : { kind: 'auto_reply', status: 'error', detail: result.error ?? 'Not sent' }
}
