import nodemailer from 'nodemailer'
import { z } from 'zod'

import { describeThrown } from './errors.ts'
import type { Logger } from './logger.ts'

/**
 * The port Kelpie sends transactional mail through: invites, password resets,
 * and account-change notifications, nothing else. Kelpie never sends outreach
 * email.
 *
 * Roadmap decision 4: the provider is configured, never hardcoded. Core ships
 * the port and two providers, `log` and `smtp`. Both need no vendor account a
 * deployment doesn't already have, which is what keeps them in core rather than
 * a module, per `modules.md`'s split test. A provider that does need one
 * (Resend, Postmark, Mailtrap, SendGrid) is a commercial integration under that
 * same test and belongs in a module: it supplies its own `EmailSender` from its
 * own config, and an assembly's entry point wires it into `services.email` in
 * place of `createEmailSender`, the same way `kelpie-cloud/src/server.ts` wires
 * this one today.
 */

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly body: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

const logEmailConfigSchema = z.object({
  EMAIL_PROVIDER: z.literal('log'),
  EMAIL_FROM: z.string().min(1),
})

const smtpEmailConfigSchema = z.object({
  EMAIL_PROVIDER: z.literal('smtp'),
  EMAIL_FROM: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().max(65535),
  SMTP_SECURE: z.enum(['true', 'false']).transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
})

export const emailConfigSchema = z.discriminatedUnion('EMAIL_PROVIDER', [
  logEmailConfigSchema,
  smtpEmailConfigSchema,
])

export type EmailConfig = z.infer<typeof emailConfigSchema>
export type SmtpEmailConfig = z.infer<typeof smtpEmailConfigSchema>

/**
 * Writes the message to the log instead of sending it. For self-hosted
 * development, where the reset link in the log is exactly what you want.
 *
 * This is a deliberate choice, not a fallback: `EMAIL_PROVIDER` has no default,
 * so nobody reaches this provider without naming it.
 */
export function createLogEmailSender(logger: Logger, from: string): EmailSender {
  return {
    send(message) {
      logger.info('email not sent: provider is "log"', {
        from,
        to: message.to,
        subject: message.subject,
        body: message.body,
      })

      return Promise.resolve()
    },
  }
}

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
    async send(message) {
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
 * Builds the configured sender.
 *
 * @throws Never. An unknown provider cannot reach here: the config schema is a
 *   discriminated union, so boot rejects it first.
 */
export function createEmailSender(config: EmailConfig, logger: Logger): EmailSender {
  switch (config.EMAIL_PROVIDER) {
    case 'log':
      return createLogEmailSender(logger, config.EMAIL_FROM)
    case 'smtp':
      return createSmtpEmailSender(config, logger)
  }
}
