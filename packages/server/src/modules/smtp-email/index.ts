import nodemailer from 'nodemailer'
import { z } from 'zod'

import { isLoopbackHost } from '../../lib/deploymentChecks.ts'
import { describeThrown } from '../../lib/errors.ts'
import { EMAIL_FROM_PROBLEM, PermanentEmailError, emailFromSchema, emailHeadersProblem } from '../../lib/email.ts'
import type { EmailMessage, EmailSender } from '../../lib/email.ts'
import { parseSenderAddress } from '../../lib/emailAddress.ts'
import type { Logger } from '../../lib/logger.ts'
import type { KelpieModule } from '../../runtime/module.ts'

/**
 * The built-in SMTP email module.
 *
 * Registers a provider named `'smtp'` with core's email runtime. An assembly
 * that sets `email.provider: 'smtp'` in its `kelpie.config.ts` uses this
 * sender; any other value picks a different provider (`'log'` for the built-in
 * or another provider module's name). Reads `EMAIL_FROM` and `SMTP_*` from the
 * environment; missing or malformed values fail boot.
 *
 * `SMTP_USER` and `SMTP_PASSWORD` are optional and go together. Set both to
 * authenticate against the relay. Leave both unset or empty to connect
 * without SMTP AUTH, which is how local catch-alls (maildev, MailHog,
 * smtp4dev) work. Setting exactly one fails boot: a half-configured
 * credential pair is a bug, not a mode.
 *
 * The connection is always encrypted before the sign-in and the message go to
 * a relay on another machine. `SMTP_SECURE=true` uses TLS from the first byte.
 * `SMTP_SECURE=false` starts in plain text and must upgrade with STARTTLS: a
 * relay that does not offer it fails the send. Without that rule a party on
 * the network can remove the offer, and then read the SMTP password and every
 * reset link. Two cases are exempt (`smtpRequiresStartTls`): a relay on this
 * machine, and a relay the operator names with `SMTP_REQUIRE_TLS=false`.
 *
 * A commercial email integration (Resend, Postmark) belongs in its own module
 * following the same shape, registered under a different name.
 */

/**
 * The name this module registers under. An assembly puts `provider: 'smtp'`
 * in its `email` block to pick it.
 */
export const SMTP_EMAIL_PROVIDER = 'smtp'

export type { EmailMessage } from '../../lib/email.ts'

/**
 * An empty value counts as unset. The scaffolded `.env` writes `SMTP_USER=`
 * and `SMTP_PASSWORD=` with no value, and dotenv reads those lines as empty
 * strings. Without this rule a local catch-all could not boot from that file.
 */
const optionalCredentialSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
)

export const smtpEmailConfigSchema = z
  .object({
    EMAIL_FROM: emailFromSchema,
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().positive().max(65535),
    SMTP_SECURE: z.enum(['true', 'false']).transform((value) => value === 'true'),
    // Optional: unset means "required, except for a relay on this machine".
    SMTP_REQUIRE_TLS: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    SMTP_USER: optionalCredentialSchema,
    SMTP_PASSWORD: optionalCredentialSchema,
  })
  .superRefine((config, ctx) => {
    // A half-set pair is a misconfiguration, not a mode. Report both keys so
    // the operator sees which side of the pair is missing without having to
    // guess.
    if ((config.SMTP_USER === undefined) !== (config.SMTP_PASSWORD === undefined)) {
      const message = 'SMTP_USER and SMTP_PASSWORD must be set together, or both left unset or empty for an unauthenticated relay'

      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['SMTP_USER'] })
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['SMTP_PASSWORD'] })
    }
  })

export type SmtpEmailConfig = z.infer<typeof smtpEmailConfigSchema>

/**
 * What `createSmtpEmailSender` sends a message through. A real deployment gets
 * one backed by `nodemailer`; a test injects one that records calls, so the
 * sender is verifiable without a container running a real SMTP conversation.
 */
export interface SmtpTransport {
  sendMail(message: {
    from: string | { name: string; address: string }
    to: string
    subject: string
    text: string
    html?: string
    replyTo?: string
    headers?: Record<string, string>
  }): Promise<unknown>
}

/**
 * How long the SMTP client waits, in milliseconds, at each step of a send.
 */
export interface SmtpTimeouts {
  /** To resolve the host name. */
  readonly dns: number
  /** To open the TCP connection. */
  readonly connection: number
  /** For the server's greeting, after the connection opens. */
  readonly greeting: number
  /** With no data on an open socket, before the client gives up. */
  readonly socket: number
}

// Emails are sent from background jobs, and a module can still send one
// inside an HTTP request, so a slow or silent mail server must fail the send
// in seconds. nodemailer's own defaults are 2 minutes to connect, 30 seconds
// each for DNS and the greeting, and 10 minutes for an idle socket, which
// holds a worker slot, or a request, open for as long.
// The socket limit is the longest: a relay can be quiet for some seconds
// after the message body while it scans it.
const SMTP_DNS_TIMEOUT_MS = 10_000
const SMTP_CONNECTION_TIMEOUT_MS = 10_000
const SMTP_GREETING_TIMEOUT_MS = 10_000
const SMTP_SOCKET_TIMEOUT_MS = 30_000

/** The limits a real deployment sends with. */
export const SMTP_TIMEOUTS: SmtpTimeouts = {
  dns: SMTP_DNS_TIMEOUT_MS,
  connection: SMTP_CONNECTION_TIMEOUT_MS,
  greeting: SMTP_GREETING_TIMEOUT_MS,
  socket: SMTP_SOCKET_TIMEOUT_MS,
}

/**
 * Whether a connection that starts in plain text must upgrade with STARTTLS
 * before anything else goes over it. Applies when `SMTP_SECURE` is `false`.
 *
 * `SMTP_REQUIRE_TLS` decides when it is set. Unset, the upgrade is required
 * for every host except this machine (`localhost`, a `.localhost` name, a
 * loopback address): traffic to it does not go on a network, and a local mail
 * catcher (maildev, MailHog, smtp4dev) has no TLS.
 */
export function smtpRequiresStartTls(
  config: Pick<SmtpEmailConfig, 'SMTP_HOST' | 'SMTP_REQUIRE_TLS'>,
): boolean {
  return config.SMTP_REQUIRE_TLS ?? !isLoopbackHost(config.SMTP_HOST)
}

/**
 * The warning for a config that lets mail go in plain text to another machine,
 * or `undefined` when there is nothing to say. The module writes it at boot.
 */
export function smtpPlainTextWarning(
  config: Pick<SmtpEmailConfig, 'SMTP_HOST' | 'SMTP_SECURE' | 'SMTP_REQUIRE_TLS'>,
): string | undefined {
  if (config.SMTP_SECURE || smtpRequiresStartTls(config) || isLoopbackHost(config.SMTP_HOST)) {
    return undefined
  }

  return (
    'SMTP_REQUIRE_TLS is "false" and SMTP_HOST is not this machine. ' +
    'When the relay does not offer STARTTLS, the SMTP password and each message go in plain text. ' +
    'Use this only for a relay on a private network that you trust.'
  )
}

/**
 * The options the nodemailer transport is built with. Declared here, and not
 * taken from nodemailer's types, so this module's public types need no type
 * package from the assembly that installs it.
 */
export interface SmtpConnectionOptions {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  /** Set only when `secure` is `false`. */
  readonly requireTLS?: boolean
  readonly dnsTimeout: number
  readonly connectionTimeout: number
  readonly greetingTimeout: number
  readonly socketTimeout: number
  readonly auth?: { readonly user: string; readonly pass: string }
}

/**
 * Builds the connection options from the config. A function of its own so a
 * test can read the TLS rule without opening a connection.
 *
 * `tls.rejectUnauthorized` is not set, so the server certificate is always
 * checked.
 */
export function smtpConnectionOptions(config: SmtpEmailConfig, timeouts: SmtpTimeouts): SmtpConnectionOptions {
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    // Without `requireTLS` nodemailer upgrades only when the server offers
    // STARTTLS, and sends the sign-in and the message in plain text when it
    // does not. With it, a missing or refused upgrade fails the send first.
    ...(config.SMTP_SECURE ? {} : { requireTLS: smtpRequiresStartTls(config) }),
    dnsTimeout: timeouts.dns,
    connectionTimeout: timeouts.connection,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.socket,
    ...(config.SMTP_USER !== undefined && config.SMTP_PASSWORD !== undefined
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
      : {}),
  }
}

/**
 * A transport that opens a real SMTP connection. `timeouts` is a parameter so
 * a test can use short limits against a local server; a deployment uses the
 * default.
 */
export function createNodemailerTransport(
  config: SmtpEmailConfig,
  timeouts: SmtpTimeouts = SMTP_TIMEOUTS,
): SmtpTransport {
  return nodemailer.createTransport({ ...smtpConnectionOptions(config, timeouts) })
}

/**
 * The nodemailer error codes for a failure of the message itself: `EENVELOPE`
 * for the sender, a recipient or the `DATA` command, `EMESSAGE` for the
 * message after its body went to the server. Every other code is about the
 * connection, TLS or the sign-in to the relay.
 */
const MESSAGE_ERROR_CODES: ReadonlySet<string> = new Set(['EENVELOPE', 'EMESSAGE'])

/**
 * Whether an error from the transport is a permanent refusal of the message.
 *
 * nodemailer puts `code` on its errors, and `responseCode` when the server
 * gave an SMTP answer. A `5xx` answer to the sender, a recipient or the
 * message is permanent: the server says not to send it again. So is an
 * envelope error with no answer at all, which is nodemailer refusing an
 * address before it sends a command. A `4xx` answer asks for a later try.
 * A timeout, a DNS failure, a lost connection and a TLS failure say nothing
 * about the message. Neither does a `5xx` answer to the greeting or the
 * sign-in: that is a fault of the relay or of the SMTP settings, and the
 * message can go when it is repaired.
 */
export function isPermanentSmtpFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined

  if (code === undefined || !MESSAGE_ERROR_CODES.has(code)) {
    return false
  }

  const responseCode =
    'responseCode' in error && typeof error.responseCode === 'number' ? error.responseCode : undefined

  if (responseCode === undefined) {
    return code === 'EENVELOPE'
  }

  return responseCode >= 500 && responseCode <= 599
}

/**
 * Sends over SMTP. `transport` defaults to a real connection built from `config`.
 *
 * `send` throws `PermanentEmailError` when the server refused the message for
 * good (`isPermanentSmtpFailure`), and a plain `Error` for every other failure.
 *
 * @throws Error when `config.EMAIL_FROM` is not a sender. The config schema
 * refuses such a value first; this covers a caller that builds the config by
 * hand.
 */
export function createSmtpEmailSender(
  config: SmtpEmailConfig,
  logger: Logger,
  transport: SmtpTransport = createNodemailerTransport(config),
): EmailSender {
  const sender = parseSenderAddress(config.EMAIL_FROM)

  if (sender === undefined) {
    throw new Error(`EMAIL_FROM ${EMAIL_FROM_PROBLEM}`)
  }

  return {
    async send(message: EmailMessage) {
      // The name and the address go to the mail library as two values, so a
      // comma in a name cannot be read as a second address.
      const name = message.fromName ?? sender.name

      // The runtime does this check for a sender it resolved. It is done
      // again here for a caller that uses this sender directly.
      const headersProblem = emailHeadersProblem(message.headers)

      if (headersProblem !== undefined) {
        throw new Error(headersProblem)
      }

      try {
        await transport.sendMail({
          from: name === undefined ? sender.address : { name, address: sender.address },
          to: message.to,
          subject: message.subject,
          text: message.body,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
          ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
        })
      } catch (cause) {
        const reason = describeThrown(cause)
        const permanent = isPermanentSmtpFailure(cause)
        const text = `Failed to send email to ${message.to} over SMTP: ${reason}`

        logger.error('smtp send failed', { to: message.to, reason, permanent })

        throw permanent ? new PermanentEmailError(text, { cause }) : new Error(text, { cause })
      }
    },
  }
}

/**
 * Options a caller may pass when building the module. `transport` is here for
 * tests; a real deployment omits it and lets the module open a nodemailer
 * connection from the resolved config.
 */
export interface SmtpEmailModuleOptions {
  readonly transport?: SmtpTransport
}

/**
 * The built-in SMTP module. Registers a factory under `SMTP_EMAIL_PROVIDER`;
 * the factory reads the SMTP environment and builds the nodemailer sender, but
 * only if the assembly's `email.provider` picks this module. Boot fails loudly
 * on a missing or malformed required variable, or on a half-set
 * `SMTP_USER` / `SMTP_PASSWORD` pair. Omitting both credentials is valid and
 * makes the module connect without SMTP AUTH. A config that permits plain text
 * to another machine boots with a warning (`smtpPlainTextWarning`).
 *
 * The module stays in `coreModules` unconditionally: on any other provider
 * (e.g. `EMAIL_PROVIDER=log`) the factory never runs, so the SMTP environment
 * is not checked.
 */
export function createSmtpEmailModule(options: SmtpEmailModuleOptions = {}): KelpieModule {
  return {
    id: 'smtp-email',
    structural: true,

    register(context) {
      context.provideEmailSender(SMTP_EMAIL_PROVIDER, () => {
        const config = context.config(smtpEmailConfigSchema)
        const plainTextWarning = smtpPlainTextWarning(config)

        if (plainTextWarning !== undefined) {
          context.log.warn(plainTextWarning)
        }

        return options.transport === undefined
          ? createSmtpEmailSender(config, context.log)
          : createSmtpEmailSender(config, context.log, options.transport)
      })

      return Promise.resolve()
    },
  }
}
