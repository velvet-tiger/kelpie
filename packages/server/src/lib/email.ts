import { z } from 'zod'

import { parseSenderAddress } from './emailAddress.ts'
import { describeThrown } from './errors.ts'
import type { Logger } from './logger.ts'

/**
 * The port Kelpie sends transactional mail through: invites, password resets,
 * account-change notifications, and form emails (a notification to the people
 * a form names, and an auto-reply that confirms a submit to the submitter),
 * nothing else. Kelpie never sends outreach email.
 *
 * The assembly names one named provider in `kelpie.config.ts`'s
 * `email.provider`. The module runtime resolves the name against a registry
 * every module can contribute to via `context.provideEmailSender(name, sender)`.
 * `'log'` is a built-in name the runtime always registers, so a bare install
 * has something to point at. `'smtp'` is registered by the built-in
 * `smtp-email` core module. Other names come from third-party provider modules
 * (Resend, Postmark, SES) that follow the same registry pattern. Transport is
 * arbitrary: the module builds one behind the `EmailSender` interface and
 * hands it to core, which knows only how to `send`.
 */

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  /** The plaintext part. Always present: text-only clients and logs read it. */
  readonly body: string
  /**
   * The HTML alternative, rendered by `lib/emailContent.ts`. Optional so
   * provider modules written against the older port keep compiling and a
   * plain-text message stays expressible.
   */
  readonly html?: string
  /**
   * Where a reply goes, when not to the From address. Optional, and a provider
   * module written before it existed ignores it: the message still arrives,
   * and a reply goes to the From address instead.
   */
  readonly replyTo?: string
  /**
   * The display name on the From header, in place of the one `EMAIL_FROM`
   * carries. The address stays the deployment's. Optional, and a provider
   * module written before it existed ignores it: the message still arrives,
   * under the deployment's own name.
   */
  readonly fromName?: string
  /**
   * More headers for the message, by name: `{ 'Auto-Submitted': 'auto-replied' }`.
   * For headers that tell a mail system how to handle the message. The port
   * owns the headers its other fields write (`PORT_OWNED_EMAIL_HEADERS`), and
   * those are refused here. Core checks the names and the values before a
   * provider gets the message (`emailHeadersProblem`), so a provider can pass
   * them to its transport as they are. Optional, and a provider module
   * written before it existed ignores it: the message still arrives, without
   * the headers.
   */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Headers the port writes from its own fields, or that the transport writes.
 * A message cannot set them through `headers`. Lower case; a header name has
 * no case.
 */
export const PORT_OWNED_EMAIL_HEADERS: ReadonlySet<string> = new Set([
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'bcc',
  'subject',
  'date',
  'message-id',
  'return-path',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
])

/** A header name: printable ASCII with no space and no colon. */
const HEADER_NAME = /^[!-9;-~]+$/u

/**
 * Characters a header value cannot hold: every line break and control
 * character. A line break in a value starts a new header.
 */
const REFUSED_HEADER_VALUE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u

/**
 * Checks the `headers` of a message. The runtime calls this before each send,
 * for every provider.
 *
 * @returns What is wrong with the first bad header, or `undefined` when all
 * are safe to write.
 */
export function emailHeadersProblem(headers: Readonly<Record<string, string>> | undefined): string | undefined {
  const seen = new Set<string>()

  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase()

    if (!HEADER_NAME.test(name)) {
      return `email header name ${JSON.stringify(name)} is not a valid header name`
    }

    if (PORT_OWNED_EMAIL_HEADERS.has(key)) {
      return `email header "${name}" is set by the email port and cannot be in headers`
    }

    if (seen.has(key)) {
      return `email header "${name}" is in headers more than once`
    }

    if (typeof value !== 'string' || value.trim().length === 0 || REFUSED_HEADER_VALUE_CHARACTERS.test(value)) {
      return `email header "${name}" has an empty value, or a value with a line break or control character`
    }

    seen.add(key)
  }

  return undefined
}

/**
 * Headers for a message Kelpie makes with no person writing it: an account
 * email, an invitation, a form notification. `Auto-Submitted` (RFC 3834) tells
 * an out-of-office system not to answer. Microsoft Exchange reads
 * `X-Auto-Response-Suppress` for the same purpose.
 */
export const AUTO_GENERATED_EMAIL_HEADERS: Readonly<Record<string, string>> = {
  'Auto-Submitted': 'auto-generated',
  'X-Auto-Response-Suppress': 'OOF, AutoReply',
}

/** The same, for a message that answers one a person sent: a form auto-reply. */
export const AUTO_REPLIED_EMAIL_HEADERS: Readonly<Record<string, string>> = {
  'Auto-Submitted': 'auto-replied',
  'X-Auto-Response-Suppress': 'OOF, AutoReply',
}

export interface EmailSender {
  /**
   * @throws PermanentEmailError when the same message can never be delivered,
   * and any other error when a later try can work.
   */
  send(message: EmailMessage): Promise<void>
}

/** The `name` of every `PermanentEmailError`. `isPermanentEmailError` reads it. */
const PERMANENT_EMAIL_ERROR_NAME = 'PermanentEmailError'

/**
 * What a provider throws from `send` when the failure is permanent: the mail
 * system refused the message, and the same message gets the same refusal on
 * every later try. An address that does not exist, a recipient domain that
 * accepts no mail, and a message the server refuses for its content are
 * permanent. A timeout, a lost connection, a rate limit, and a "try again
 * later" answer are not: for those a provider throws any other error.
 *
 * A job that sends an email does not retry a permanent failure. An error that
 * is not a `PermanentEmailError` is retried, so a provider that makes no
 * distinction keeps the behaviour it had before this class existed.
 */
export class PermanentEmailError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = PERMANENT_EMAIL_ERROR_NAME
  }
}

/**
 * Whether a thrown value is a permanent email failure. Use this, not
 * `instanceof`, to decide: an assembly can hold two copies of this package
 * (a provider module with its own install), and the class of one copy is not
 * the class of the other. The name is the same in both.
 */
export function isPermanentEmailError(error: unknown): boolean {
  return error instanceof Error && error.name === PERMANENT_EMAIL_ERROR_NAME
}

/** The most characters of a failure that a job stores for people to read. */
const EMAIL_FAILURE_DETAIL_MAX_LENGTH = 300

/**
 * Why a send failed, as a job stores it for a person to read: the thrown
 * value's own description on one line, cut to
 * `EMAIL_FAILURE_DETAIL_MAX_LENGTH` characters. The form email job stores it
 * on a `form_email_sends` row, and the invitation email job on the
 * invitation.
 */
export function emailFailureDetail(error: unknown): string {
  const flat = describeThrown(error).replace(/\s+/gu, ' ').trim()

  return flat.length > EMAIL_FAILURE_DETAIL_MAX_LENGTH
    ? `${flat.slice(0, EMAIL_FAILURE_DETAIL_MAX_LENGTH - 1)}…`
    : flat
}

/**
 * Runs the part of a job that sends one email. A permanent failure is written
 * to the log and the call returns, so the job completes and the queue does
 * not retry it. Every other error goes to the caller, so the queue does.
 */
export async function completeOnPermanentEmailFailure(log: Logger, send: () => Promise<void>): Promise<void> {
  try {
    await send()
  } catch (error: unknown) {
    if (!isPermanentEmailError(error)) {
      throw error
    }

    log.warn('email not retried: the failure is permanent', { error: describeThrown(error) })
  }
}

/** What boot says when `EMAIL_FROM` is not a sender. Names both permitted forms. */
export const EMAIL_FROM_PROBLEM =
  'must be an email address (kelpie@example.com) or a name and an address (Kelpie <kelpie@example.com>)'

/**
 * `EMAIL_FROM`: one address, or a display name and one address. Checked at
 * boot, so a wrong sender stops the service there and not at the first send.
 */
export const emailFromSchema = z
  .string()
  .refine((value) => parseSenderAddress(value) !== undefined, { message: EMAIL_FROM_PROBLEM })

export const emailConfigSchema = z.object({
  /**
   * The named provider `registerModules` resolves against its registry. `'log'`
   * is a built-in, always present. Any other name needs a module that
   * registered it via `context.provideEmailSender(name, sender)`. Free-string
   * so a self-hoster can add a module core has never heard of.
   */
  EMAIL_PROVIDER: z.string().min(1),
  EMAIL_FROM: emailFromSchema,
})

export type EmailConfig = z.infer<typeof emailConfigSchema>

/**
 * Writes the message to the log instead of sending it. The registry default,
 * swapped out for a real sender by picking a different provider name in
 * `email.provider` (`'smtp'` for the built-in SMTP module, or any name a
 * third-party provider module registers).
 *
 * The line holds each field a real sender would use. `body` is the full
 * plaintext part, which is where a developer copies a link from. The HTML
 * part shows the same content with much markup, so the line gives only its
 * length, `htmlLength`. A field the message does not set is not on the line.
 */
export function createLogEmailSender(logger: Logger, from: string): EmailSender {
  return {
    send(message) {
      logger.info('email not sent: no provider module registered', {
        from,
        ...(message.fromName === undefined ? {} : { fromName: message.fromName }),
        to: message.to,
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        subject: message.subject,
        ...(message.headers === undefined ? {} : { headers: message.headers }),
        body: message.body,
        ...(message.html === undefined ? {} : { htmlLength: message.html.length }),
      })

      return Promise.resolve()
    },
  }
}
