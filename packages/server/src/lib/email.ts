import { z } from 'zod'

import type { Logger } from './logger.ts'

/**
 * The port Kelpie sends transactional mail through: invites, password resets,
 * and account-change notifications, nothing else. Kelpie never sends outreach
 * email.
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
  readonly body: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

export const emailConfigSchema = z.object({
  /**
   * The named provider `registerModules` resolves against its registry. `'log'`
   * is a built-in, always present. Any other name needs a module that
   * registered it via `context.provideEmailSender(name, sender)`. Free-string
   * so a self-hoster can add a module core has never heard of.
   */
  EMAIL_PROVIDER: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
})

export type EmailConfig = z.infer<typeof emailConfigSchema>

/**
 * Writes the message to the log instead of sending it. The registry default,
 * swapped out for a real sender by picking a different provider name in
 * `email.provider` (`'smtp'` for the built-in SMTP module, or any name a
 * third-party provider module registers).
 */
export function createLogEmailSender(logger: Logger, from: string): EmailSender {
  return {
    send(message) {
      logger.info('email not sent: no provider module registered', {
        from,
        to: message.to,
        subject: message.subject,
        body: message.body,
      })

      return Promise.resolve()
    },
  }
}
