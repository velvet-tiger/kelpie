import nodemailer from 'nodemailer'
import { z } from 'zod'

import { describeThrown } from '../../lib/errors.ts'
import type { EmailMessage, EmailSender } from '../../lib/email.ts'
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
 * A commercial email integration (Resend, Postmark) belongs in its own module
 * following the same shape, registered under a different name.
 */

/**
 * The name this module registers under. An assembly puts `provider: 'smtp'`
 * in its `email` block to pick it.
 */
export const SMTP_EMAIL_PROVIDER = 'smtp'

export type { EmailMessage } from '../../lib/email.ts'

const smtpEmailConfigSchema = z.object({
  EMAIL_FROM: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().max(65535),
  SMTP_SECURE: z.enum(['true', 'false']).transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
})

export type SmtpEmailConfig = z.infer<typeof smtpEmailConfigSchema>

/**
 * What `createSmtpEmailSender` sends a message through. A real deployment gets
 * one backed by `nodemailer`; a test injects one that records calls, so the
 * sender is verifiable without a container running a real SMTP conversation.
 */
export interface SmtpTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>
}

function createNodemailerTransport(config: SmtpEmailConfig): SmtpTransport {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
  })
}

/** Sends over SMTP. `transport` defaults to a real connection built from `config`. */
export function createSmtpEmailSender(
  config: SmtpEmailConfig,
  logger: Logger,
  transport: SmtpTransport = createNodemailerTransport(config),
): EmailSender {
  return {
    async send(message: EmailMessage) {
      try {
        await transport.sendMail({
          from: config.EMAIL_FROM,
          to: message.to,
          subject: message.subject,
          text: message.body,
        })
      } catch (cause) {
        const reason = describeThrown(cause)
        logger.error('smtp send failed', { to: message.to, reason })
        throw new Error(`Failed to send email to ${message.to} over SMTP: ${reason}`, { cause })
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
 * if any SMTP variable is missing or malformed at that point.
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

        return options.transport === undefined
          ? createSmtpEmailSender(config, context.log)
          : createSmtpEmailSender(config, context.log, options.transport)
      })

      return Promise.resolve()
    },
  }
}
