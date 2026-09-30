import { and, asc, count, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import type { FormEmailKind, FormEmailRecipient, FormEmailSendStatus, FormSubmissionActionEntry } from '@kelpie/schemas'

import type { Queryable } from '../../runtime/transaction.ts'
import { formEmailSends, formNotifyRecipients, formSubmissions } from './schema.ts'

/**
 * The tables behind form emails: the notification's recipients, and the log
 * of every message the email job sent or tried to send.
 *
 * Its own file rather than more of `repository.ts`, which already holds the
 * form, its fields, its lists, its attach targets and its submissions.
 */

export type FormEmailSendRecord = typeof formEmailSends.$inferSelect
export type FormEmailSendColumns = typeof formEmailSends.$inferInsert

type NotifyRecipientRow = typeof formNotifyRecipients.$inferSelect

function toRecipient(row: NotifyRecipientRow): FormEmailRecipient {
  // The check constraint guarantees the column that matches `kind` is set.
  return row.kind === 'member'
    ? { kind: 'member', memberId: row.memberId ?? '' }
    : { kind: 'address', address: row.address ?? '' }
}

/** A form's notification recipients, in the order the builder shows them. */
export async function listNotifyRecipients(
  db: Queryable,
  formId: string,
): Promise<FormEmailRecipient[]> {
  const rows = await db
    .select()
    .from(formNotifyRecipients)
    .where(eq(formNotifyRecipients.formId, formId))
    .orderBy(asc(formNotifyRecipients.position))

  return rows.map(toRecipient)
}

/** The recipients of several forms in one query, for a list page. */
export async function listNotifyRecipientsFor(
  db: Queryable,
  formIds: readonly string[],
): Promise<ReadonlyMap<string, FormEmailRecipient[]>> {
  const byForm = new Map<string, FormEmailRecipient[]>()

  if (formIds.length === 0) {
    return byForm
  }

  const rows = await db
    .select()
    .from(formNotifyRecipients)
    .where(inArray(formNotifyRecipients.formId, [...formIds]))
    .orderBy(asc(formNotifyRecipients.formId), asc(formNotifyRecipients.position))

  for (const row of rows) {
    byForm.set(row.formId, [...(byForm.get(row.formId) ?? []), toRecipient(row)])
  }

  return byForm
}

/** Replaces the whole list. Positions come from the array's order. */
export async function replaceNotifyRecipients(
  db: Queryable,
  workspaceId: string,
  formId: string,
  recipients: readonly FormEmailRecipient[],
): Promise<void> {
  await db.delete(formNotifyRecipients).where(eq(formNotifyRecipients.formId, formId))

  if (recipients.length === 0) {
    return
  }

  await db.insert(formNotifyRecipients).values(
    recipients.map((recipient, position) => ({
      workspaceId,
      formId,
      position,
      kind: recipient.kind,
      memberId: recipient.kind === 'member' ? recipient.memberId : null,
      address: recipient.kind === 'address' ? recipient.address : null,
    })),
  )
}

export type FormSubmissionRow = typeof formSubmissions.$inferSelect

/** A submission by id alone: the email job's payload carries no form id. */
export async function findSubmissionById(
  db: Queryable,
  workspaceId: string,
  submissionId: string,
): Promise<FormSubmissionRow | undefined> {
  const [found] = await db
    .select()
    .from(formSubmissions)
    .where(and(eq(formSubmissions.workspaceId, workspaceId), eq(formSubmissions.id, submissionId)))
    .limit(1)

  return found
}

/** Every message already tried for one submission. */
export function listEmailSends(db: Queryable, submissionId: string): Promise<FormEmailSendRecord[]> {
  return db.select().from(formEmailSends).where(eq(formEmailSends.submissionId, submissionId))
}

/**
 * Records the outcome of one message. A retry that tries the same message
 * again replaces the earlier outcome, so an `error` becomes `sent` when the
 * retry works.
 */
export async function recordEmailSend(
  db: Queryable,
  values: FormEmailSendColumns & { readonly status: FormEmailSendStatus; readonly kind: FormEmailKind },
): Promise<void> {
  await db
    .insert(formEmailSends)
    .values(values)
    .onConflictDoUpdate({
      target: [formEmailSends.submissionId, formEmailSends.kind, formEmailSends.recipient],
      set: { status: values.status, detail: values.detail ?? '', createdAt: values.createdAt ?? sql`now()` },
    })
}

/**
 * True when this form already sent an auto-reply to `recipient` since
 * `since`, for a submission other than `submissionId`. The other-submission
 * term keeps a retry of this submission's own job from blocking itself.
 */
export async function autoReplySentSince(
  db: Queryable,
  formId: string,
  recipient: string,
  since: Date,
  submissionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ total: count() })
    .from(formEmailSends)
    .where(
      and(
        eq(formEmailSends.formId, formId),
        eq(formEmailSends.kind, 'auto_reply'),
        eq(formEmailSends.recipient, recipient),
        eq(formEmailSends.status, 'sent'),
        gte(formEmailSends.createdAt, since),
        ne(formEmailSends.submissionId, submissionId),
      ),
    )

  return (row?.total ?? 0) > 0
}

/** How many auto-replies the workspace sent since `since`. */
export async function countAutoRepliesSince(
  db: Queryable,
  workspaceId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(formEmailSends)
    .where(
      and(
        eq(formEmailSends.workspaceId, workspaceId),
        eq(formEmailSends.kind, 'auto_reply'),
        eq(formEmailSends.status, 'sent'),
        gte(formEmailSends.createdAt, since),
      ),
    )

  return row?.total ?? 0
}

/**
 * Puts the email entries on the submission's `action_log`, in place of any the
 * job wrote on an earlier try. Entries for the other post-submit actions stay
 * as they are, in their order.
 */
export async function replaceEmailActionEntries(
  db: Queryable,
  workspaceId: string,
  submissionId: string,
  actions: readonly string[],
  entries: readonly FormSubmissionActionEntry[],
): Promise<void> {
  const kept = sql`coalesce((
    select jsonb_agg(entry order by position)
    from jsonb_array_elements(${formSubmissions.actionLog}) with ordinality as log(entry, position)
    where entry->>'action' not in (${sql.join(
      actions.map((action) => sql`${action}`),
      sql`, `,
    )})
  ), '[]'::jsonb)`

  await db
    .update(formSubmissions)
    .set({ actionLog: sql`${kept} || ${JSON.stringify(entries)}::jsonb` })
    .where(and(eq(formSubmissions.workspaceId, workspaceId), eq(formSubmissions.id, submissionId)))
}
