import { z } from 'zod'

import { APP_LINK_PATHS, buildAppLink } from '../../lib/appUrl.ts'
import type { Database } from '../../lib/database.ts'
import { AUTO_GENERATED_EMAIL_HEADERS, completeOnPermanentEmailFailure } from '../../lib/email.ts'
import type { EmailSender } from '../../lib/email.ts'
import { renderEmail, renderTextEmail } from '../../lib/emailContent.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { JobDefaults, JobDefinition, JobHandle } from '../../lib/jobs.ts'
import { generateToken, hashToken } from '../../lib/tokens.ts'
import * as repository from './repository.ts'

/**
 * The emails the auth module sends, each as a background job.
 *
 * A service adds the job inside the transaction that writes the account, so
 * a rolled-back write sends nothing and a committed one always has its job.
 * The request never waits on a mail server, and a mail server that is down
 * cannot turn a saved sign-up into a `500`.
 *
 * No payload holds a token. The verification and reset handlers make the
 * token when they run: they store its hash, put the token in the email, and
 * keep it nowhere else. A job row can stay in the queue's tables for days
 * after it ends, and a token in it would be a working link at rest. A retry
 * makes a new token. The hash of a token that was never delivered stays in
 * its table until it expires; nobody holds that token, so it opens nothing.
 *
 * Each email is its own job. A notice to the old address that fails is
 * retried alone, and does not hold back the verification email to the new
 * address.
 *
 * A permanent failure (`PermanentEmailError`: the mail system refused the
 * message for good) is not retried. The handler writes it to the log and the
 * job completes. The person asks for the email again, with an address that
 * takes mail.
 */

export const SEND_VERIFICATION_EMAIL_JOB = 'auth.send-verification-email'
export const SEND_PASSWORD_RESET_EMAIL_JOB = 'auth.send-password-reset-email'
export const SEND_EMAIL_CHANGE_NOTICE_JOB = 'auth.send-email-change-notice'

export const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000
/** Longer than a reset token: there is no stolen-account urgency, and an inbox is checked on its own time. */
export const EMAIL_VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * Three retries, 30 seconds apart and doubling: the last one runs about four
 * minutes after the request. A person who asked for a link waits minutes for
 * it, not hours, and each of these emails has a way to ask again.
 */
const EMAIL_JOB_DEFAULTS: JobDefaults = { retryLimit: 3, retryDelay: 30, retryBackoff: true }

export const sendVerificationEmailDataSchema = z.object({
  userId: z.string().min(1),
  /**
   * The address the email was asked for. When the account has moved to a
   * different address since, the job for that change sends the email.
   */
  email: z.string().min(1),
  /** When the request was made, as an ISO 8601 instant. */
  requestedAt: z.iso.datetime(),
})

export const sendPasswordResetEmailDataSchema = z.object({
  /**
   * The address as the caller typed it, normalised. Not a user id: the
   * request adds this job for every address, registered or not, so it does
   * the same work for both. The handler looks the account up.
   */
  email: z.string().min(1),
  requestedAt: z.iso.datetime(),
})

export const sendEmailChangeNoticeDataSchema = z.object({
  previousEmail: z.string().min(1),
  newEmail: z.string().min(1),
})

export type SendVerificationEmailData = z.infer<typeof sendVerificationEmailDataSchema>
export type SendPasswordResetEmailData = z.infer<typeof sendPasswordResetEmailDataSchema>
export type SendEmailChangeNoticeData = z.infer<typeof sendEmailChangeNoticeDataSchema>

/** The handles the auth service enqueues against. */
export interface AuthEmailJobs {
  readonly verification: JobHandle<SendVerificationEmailData>
  readonly passwordReset: JobHandle<SendPasswordResetEmailData>
  readonly emailChangeNotice: JobHandle<SendEmailChangeNoticeData>
}

export interface AuthEmailDependencies {
  readonly db: Database
  readonly email: EmailSender
  readonly createId: IdFactory
  readonly now: () => Date
  /** The deployment's own base URL. Every emailed link is built from it. */
  readonly appBaseUrl: string
  /** Injected only so tests can pin tokens. Production uses the crypto default. */
  readonly newToken?: () => string
}

/**
 * Whether a job waited in the queue for longer than its link would have
 * lived. A worker that was down for a day must not send a reset link nobody
 * is waiting for when it comes back.
 */
function waitedTooLong(requestedAt: string, now: Date, lifetimeMs: number): boolean {
  return now.getTime() - new Date(requestedAt).getTime() > lifetimeMs
}

/**
 * Runs one verification job. Exported so a test can run the handler directly,
 * without a worker polling the queue.
 *
 * Sends nothing when the account is gone, is already verified, or has moved
 * to a different address since the request.
 *
 * @throws The sender's error. The job's handler lets the queue retry it,
 *   unless it is a permanent failure.
 */
export async function sendVerificationEmail(
  dependencies: AuthEmailDependencies,
  data: SendVerificationEmailData,
): Promise<void> {
  const now = dependencies.now()

  if (waitedTooLong(data.requestedAt, now, EMAIL_VERIFICATION_TOKEN_LIFETIME_MS)) {
    return
  }

  const user = await repository.findUserById(dependencies.db, data.userId)

  if (user === undefined || user.emailVerifiedAt !== null || user.email !== data.email) {
    return
  }

  const token = (dependencies.newToken ?? generateToken)()

  await repository.insertEmailVerificationToken(dependencies.db, {
    id: dependencies.createId('emailVerificationToken'),
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_LIFETIME_MS),
  })

  const link = buildAppLink(dependencies.appBaseUrl, APP_LINK_PATHS.verifyEmail, token)
  const { text, html } = renderEmail(
    {
      action: {
        instructions: 'Confirm this address to finish setting up your account:',
        buttonText: 'Verify email address',
        link,
      },
      outro: 'The link expires in 24 hours.',
    },
    dependencies.appBaseUrl,
  )

  await dependencies.email.send({
    to: user.email,
    subject: 'Verify your Kelpie email address',
    body: text,
    html,
    headers: AUTO_GENERATED_EMAIL_HEADERS,
  })
}

/**
 * Runs one password reset job. Sends nothing when no account has the address:
 * this is where a registered address and an unknown one part, out of sight of
 * the caller.
 *
 * @throws The sender's error. The job's handler lets the queue retry it,
 *   unless it is a permanent failure.
 */
export async function sendPasswordResetEmail(
  dependencies: AuthEmailDependencies,
  data: SendPasswordResetEmailData,
): Promise<void> {
  const now = dependencies.now()

  if (waitedTooLong(data.requestedAt, now, RESET_TOKEN_LIFETIME_MS)) {
    return
  }

  const user = await repository.findUserByEmail(dependencies.db, data.email)

  if (user === undefined) {
    return
  }

  const token = (dependencies.newToken ?? generateToken)()

  await repository.insertPasswordResetToken(dependencies.db, {
    id: dependencies.createId('passwordResetToken'),
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS),
  })

  const link = buildAppLink(dependencies.appBaseUrl, APP_LINK_PATHS.passwordReset, token)
  const { text, html } = renderEmail(
    {
      action: {
        instructions: 'Use this link within the hour to choose a new password:',
        buttonText: 'Reset password',
        link,
      },
      outro: 'If you did not ask for this, ignore it.',
    },
    dependencies.appBaseUrl,
  )

  await dependencies.email.send({
    to: user.email,
    subject: 'Reset your Kelpie password',
    body: text,
    html,
    headers: AUTO_GENERATED_EMAIL_HEADERS,
  })
}

/**
 * Tells the address an account moved away from. It reads nothing: the old
 * address is no longer stored anywhere but the payload.
 *
 * @throws The sender's error. The job's handler lets the queue retry it,
 *   unless it is a permanent failure.
 */
export async function sendEmailChangeNotice(
  dependencies: AuthEmailDependencies,
  data: SendEmailChangeNoticeData,
): Promise<void> {
  // Both addresses are text somebody typed, so the HTML part escapes
  // them. The fixed-copy renderer would put them in as markup.
  const { text, html } = renderTextEmail(
    {
      intro: `Your Kelpie sign-in email changed from ${data.previousEmail} to ${data.newEmail}. If you did not make this change, reset your password right away.`,
    },
    dependencies.appBaseUrl,
  )

  await dependencies.email.send({
    to: data.previousEmail,
    subject: 'Your Kelpie sign-in email changed',
    body: text,
    html,
    headers: AUTO_GENERATED_EMAIL_HEADERS,
  })
}

export function defineSendVerificationEmailJob(
  dependencies: AuthEmailDependencies,
): JobDefinition<SendVerificationEmailData> {
  return {
    name: SEND_VERIFICATION_EMAIL_JOB,
    schema: sendVerificationEmailDataSchema,
    defaults: EMAIL_JOB_DEFAULTS,
    handler: async ({ data, log }) => {
      await completeOnPermanentEmailFailure(log, () => sendVerificationEmail(dependencies, data))
    },
  }
}

export function defineSendPasswordResetEmailJob(
  dependencies: AuthEmailDependencies,
): JobDefinition<SendPasswordResetEmailData> {
  return {
    name: SEND_PASSWORD_RESET_EMAIL_JOB,
    schema: sendPasswordResetEmailDataSchema,
    defaults: EMAIL_JOB_DEFAULTS,
    handler: async ({ data, log }) => {
      await completeOnPermanentEmailFailure(log, () => sendPasswordResetEmail(dependencies, data))
    },
  }
}

export function defineSendEmailChangeNoticeJob(
  dependencies: AuthEmailDependencies,
): JobDefinition<SendEmailChangeNoticeData> {
  return {
    name: SEND_EMAIL_CHANGE_NOTICE_JOB,
    schema: sendEmailChangeNoticeDataSchema,
    defaults: EMAIL_JOB_DEFAULTS,
    handler: async ({ data, log }) => {
      await completeOnPermanentEmailFailure(log, () => sendEmailChangeNotice(dependencies, data))
    },
  }
}
