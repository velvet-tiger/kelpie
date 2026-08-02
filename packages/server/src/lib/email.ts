import { z } from 'zod'

import type { Logger } from './logger.ts'

/**
 * The port Kelpie sends transactional mail through: invites and password resets,
 * nothing else. Kelpie never sends outreach email.
 *
 * Roadmap decision 4: the provider is configured, never hardcoded. Core ships the
 * port and the `log` provider. Real providers ship as modules, so the open-source
 * assembly has no vendor account baked into it.
 */

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly body: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

export const emailConfigSchema = z.object({
  EMAIL_PROVIDER: z.enum(['log']),
  EMAIL_FROM: z.string().min(1),
})

export type EmailConfig = z.infer<typeof emailConfigSchema>

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
 * Builds the configured sender.
 *
 * @throws Never. An unknown provider cannot reach here: the config schema is an
 *   enum, so boot rejects it first.
 */
export function createEmailSender(config: EmailConfig, logger: Logger): EmailSender {
  switch (config.EMAIL_PROVIDER) {
    case 'log':
      return createLogEmailSender(logger, config.EMAIL_FROM)
  }
}
