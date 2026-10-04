import { z } from 'zod'

import { APP_LINK_PATHS, buildAppLink } from '../../lib/appUrl.ts'
import type { Database } from '../../lib/database.ts'
import {
  AUTO_GENERATED_EMAIL_HEADERS,
  completeOnPermanentEmailFailure,
  emailFailureDetail,
  isPermanentEmailError,
} from '../../lib/email.ts'
import type { EmailSender } from '../../lib/email.ts'
import { renderTextEmail } from '../../lib/emailContent.ts'
import type { JobDefinition } from '../../lib/jobs.ts'
import { generateToken, hashToken } from '../../lib/tokens.ts'
import * as repository from './repository.ts'

/**
 * `workspace.send-invite-email`: the email an invitation, or a resend of one,
 * asked for.
 *
 * The service adds the job inside the transaction that writes the invitation,
 * so a rolled-back invite reaches no inbox, and the admin's request never
 * waits on a mail server.
 *
 * The payload holds no token. The handler makes the token when it runs, puts
 * its hash on the invitation, and puts the token in the email and nowhere
 * else. A job row can stay in the queue's tables for days after it ends, and
 * a token in it would be a working link at rest. A retry makes a new token,
 * which retires the one before it, so only the link in the newest email
 * works.
 *
 * The payload does hold `request`, the number of the email request the job
 * belongs to: `invites.email_request` as it was when the service added the
 * job. A resend gives the invitation the next number. A job acts only while
 * the invitation still holds the job's number. A job of an older request
 * sends nothing, puts no token on the invitation, and records no failure, so
 * a late run of an old job cannot retire the link of the new email or mark
 * an invitation whose new email arrived. Each write of the job has the
 * number in its condition, so a resend between the job's read and its write
 * wins. One case stays: a resend that arrives while an old job is in the
 * middle of its send. That old email can still arrive, with a link the
 * resend has already retired; the new email has the link that works.
 *
 * A permanent failure (`PermanentEmailError`: the mail system refused the
 * message for good) is not retried. The handler writes it to the log and the
 * job completes. The invitation stays pending, so the admin can revoke it
 * and invite the correct address.
 *
 * An email that will not arrive is recorded on the invitation, in
 * `email_failed_at` and `email_failure`, so the admin sees it in the list of
 * invitations. That is a permanent failure, and any other failure of the
 * send on the job's last run (`lastAttempt`): the queue has no retry left. A
 * failure on an earlier run records nothing, because a retry follows. A send
 * that works removes the record, and so does a resend.
 *
 * A worker that dies during the last run records nothing: no handler runs to
 * the end. The queue then moves the job to the dead-letter queue, and
 * `recordDeadInviteEmail` (the job's `onDeadLetter`) records the failure
 * with a general reason. A job whose handler failed on the last run goes to
 * the dead-letter queue too; its failure is already recorded, and stays.
 *
 * The email names the workspace and the member who made the invitation, so
 * the person who gets it can tell where it came from. A resend names the
 * same member: `invites.invited_by` is set when the invitation is made and a
 * resend does not change it. The names are text that users typed. See
 * `displayName` for what the subject does with them; the HTML part escapes
 * them.
 */

export const SEND_INVITE_EMAIL_JOB = 'workspace.send-invite-email'

const DAY_MS = 24 * 60 * 60 * 1000

export const INVITE_LIFETIME_MS = 7 * DAY_MS

/** The most characters of one name that the email shows. */
const DISPLAY_NAME_MAX_LENGTH = 60

/**
 * A name as the email shows it: one line, and not longer than
 * `DISPLAY_NAME_MAX_LENGTH` characters.
 *
 * A workspace name and a member's name are text that users typed. A line
 * break in a subject would start a new header, so each run of whitespace and
 * control characters becomes one space. A long name is cut, so it cannot
 * move the words that follow it out of view.
 */
export function displayName(name: string): string {
  const characters = Array.from(name.replace(/[\s\p{Cc}]+/gu, ' ').trim())

  return characters.length > DISPLAY_NAME_MAX_LENGTH
    ? `${characters.slice(0, DISPLAY_NAME_MAX_LENGTH - 1).join('')}…`
    : characters.join('')
}

/** The member who made the invitation, as the email names that member. */
export interface InviterName {
  /** The member's name, or the member's address when the name is empty. */
  readonly name: string
  /** The member's address, when the name is not already the address. */
  readonly email?: string
}

/**
 * @returns undefined when the invitation has no inviter (the member was
 *   removed, which sets `invited_by` to null) or the inviter has neither a
 *   name nor an address to show.
 */
async function findInviterName(
  db: Database,
  workspaceId: string,
  memberId: string | null,
): Promise<InviterName | undefined> {
  if (memberId === null) {
    return undefined
  }

  const member = await repository.findMemberWithUser(db, workspaceId, memberId)

  if (member === undefined) {
    return undefined
  }

  const name = displayName(member.name)
  const email = displayName(member.email)

  if (name === '') {
    return email === '' ? undefined : { name: email }
  }

  return email === '' ? { name } : { name, email }
}

/** "as an admin" or "as a member", or nothing for a role this file does not know. */
function roleClause(role: string): string {
  if (role === 'admin') {
    return ' as an admin'
  }

  return role === 'member' ? ' as a member' : ''
}

/** How long the link works, from `INVITE_LIFETIME_MS`: "7 days", "1 day". */
function lifetimeInWords(): string {
  const days = Math.round(INVITE_LIFETIME_MS / DAY_MS)

  return days === 1 ? '1 day' : `${String(days)} days`
}

/** The words of one invitation email. Exported for the tests of the wording. */
export interface InviteEmailWording {
  readonly subject: string
  readonly intro: string
  readonly instructions: string
  readonly outro: string
}

export function inviteEmailWording(
  workspaceName: string,
  inviter: InviterName | undefined,
  role: string,
): InviteEmailWording {
  const workspace = displayName(workspaceName)
  const target = workspace === '' ? 'a workspace' : workspace
  const joinTarget = workspace === '' ? 'a workspace' : `the workspace ${workspace}`
  const asRole = roleClause(role)
  const who =
    inviter === undefined
      ? undefined
      : inviter.email === undefined
        ? inviter.name
        : `${inviter.name} (${inviter.email})`

  return {
    subject:
      inviter === undefined
        ? `You are invited to ${target} on Kelpie`
        : `${inviter.name} invited you to ${target} on Kelpie`,
    intro:
      who === undefined
        ? `You are invited to join ${joinTarget} on Kelpie${asRole}.`
        : `${who} invited you to join ${joinTarget} on Kelpie${asRole}.`,
    instructions: `Accept the invitation within ${lifetimeInWords()}:`,
    outro: 'If you did not expect this invitation, you can ignore this email.',
  }
}

export const sendInviteEmailDataSchema = z.object({
  workspaceId: z.string().min(1),
  inviteId: z.string().min(1),
  /** `invites.email_request` at the time of the request this job is for. */
  request: z.number().int().nonnegative(),
})

export type SendInviteEmailData = z.infer<typeof sendInviteEmailDataSchema>

export interface InviteEmailDependencies {
  readonly db: Database
  readonly email: EmailSender
  readonly now: () => Date
  /** The deployment's own base URL. Every invitation link is built from it. */
  readonly appBaseUrl: string
  /** Injected only so tests can pin tokens. Production uses the crypto default. */
  readonly newToken?: () => string
}

/**
 * Runs one job. Exported so a test can run the handler directly, without a
 * worker polling the queue.
 *
 * Sends nothing when the invitation was revoked or accepted (the row is
 * gone), has expired since the request, or has a newer email request than
 * the one this job is for.
 *
 * @param lastAttempt True when the queue does not run the job again after a
 *   failure. A failed send is then recorded on the invitation.
 * @throws The sender's error, after the failure is recorded when it is
 *   permanent or `lastAttempt` is true. The job's handler lets the queue
 *   retry it, unless it is a permanent failure.
 */
export async function sendInviteEmail(
  dependencies: InviteEmailDependencies,
  data: SendInviteEmailData,
  lastAttempt = false,
): Promise<void> {
  const invite = await repository.findInvite(dependencies.db, data.workspaceId, data.inviteId)

  if (
    invite === undefined ||
    invite.status !== 'pending' ||
    invite.expiresAt <= dependencies.now() ||
    invite.emailRequest !== data.request
  ) {
    return
  }

  const token = (dependencies.newToken ?? generateToken)()
  const updated = await repository.updateInviteForEmailRequest(dependencies.db, invite.id, data.request, {
    tokenHash: hashToken(token),
  })

  // Revoked, or resent, between the read and the write.
  if (updated === undefined) {
    return
  }

  const workspace = await repository.findWorkspace(dependencies.db, data.workspaceId)
  const inviter = await findInviterName(dependencies.db, data.workspaceId, updated.invitedBy)
  const workspaceName = displayName(workspace?.name ?? '')
  const wording = inviteEmailWording(workspaceName, inviter, updated.role)
  const link = buildAppLink(dependencies.appBaseUrl, APP_LINK_PATHS.inviteAccept, token)
  // `renderTextEmail`, not `renderEmail`: the names are text that users typed,
  // and it escapes every string for the HTML part. The header shows the
  // workspace name, as the form emails do, and keeps its link: the person
  // who was invited can sign in at the deployment.
  const { text, html } = renderTextEmail(
    {
      intro: wording.intro,
      action: {
        instructions: wording.instructions,
        buttonText: 'Accept invitation',
        link,
      },
      outro: wording.outro,
    },
    dependencies.appBaseUrl,
    workspaceName === '' ? undefined : workspaceName,
  )

  try {
    await dependencies.email.send({
      to: updated.email,
      subject: wording.subject,
      body: text,
      html,
      headers: AUTO_GENERATED_EMAIL_HEADERS,
    })
  } catch (error: unknown) {
    // Only for this job's request: after a resend, the failure of this email
    // says nothing about the email the new job sends.
    if (isPermanentEmailError(error) || lastAttempt) {
      await repository.updateInviteForEmailRequest(dependencies.db, updated.id, data.request, {
        emailFailedAt: dependencies.now(),
        emailFailure: emailFailureDetail(error),
      })
    }

    throw error
  }

  // A failure of this request can be on record: an earlier run of this job
  // was its last, or the job came back from the dead-letter queue. This
  // email arrived, so the record goes.
  if (updated.emailFailedAt !== null) {
    await repository.updateInviteForEmailRequest(dependencies.db, updated.id, data.request, {
      emailFailedAt: null,
      emailFailure: null,
    })
  }
}

/**
 * What `email_failure` says when the job ended in the dead-letter queue with
 * no failure on record: no handler ran to the end, so no sender's error
 * exists to show.
 */
export const DEAD_INVITE_EMAIL_FAILURE =
  'The job that sends this email stopped before it finished. Resend the invitation.'

/**
 * Runs for a job that ended in the dead-letter queue. Exported so a test can
 * run it directly.
 *
 * Records the failure only when the invitation still holds this job's
 * request and has no failure on record. Thus it does nothing after a
 * resend, and it does not replace the reason the handler recorded on its
 * last run. A job whose send worked completes, and does not get here. The
 * exception is a worker that dies after the send and before the queue has
 * the result on the last run: that invitation is marked although its email
 * left.
 *
 * @returns True when it recorded the failure.
 */
export async function recordDeadInviteEmail(
  dependencies: Pick<InviteEmailDependencies, 'db' | 'now'>,
  data: SendInviteEmailData,
): Promise<boolean> {
  const recorded = await repository.recordInviteEmailFailureIfNone(
    dependencies.db,
    data.workspaceId,
    data.inviteId,
    data.request,
    { emailFailedAt: dependencies.now(), emailFailure: DEAD_INVITE_EMAIL_FAILURE },
  )

  return recorded !== undefined
}

export function defineSendInviteEmailJob(
  dependencies: InviteEmailDependencies,
): JobDefinition<SendInviteEmailData> {
  return {
    name: SEND_INVITE_EMAIL_JOB,
    schema: sendInviteEmailDataSchema,
    // Three retries, 30 seconds apart and doubling: the last one runs about
    // four minutes after the request. The admin has a Resend button after that.
    defaults: { retryLimit: 3, retryDelay: 30, retryBackoff: true },
    handler: async ({ data, log, lastAttempt }) => {
      await completeOnPermanentEmailFailure(log, () =>
        sendInviteEmail(dependencies, data, lastAttempt === true),
      )
    },
    onDeadLetter: async ({ data, log }) => {
      if (await recordDeadInviteEmail(dependencies, data)) {
        log.warn('invitation email not sent: the job ended in the dead-letter queue', {
          inviteId: data.inviteId,
        })
      }
    },
  }
}
