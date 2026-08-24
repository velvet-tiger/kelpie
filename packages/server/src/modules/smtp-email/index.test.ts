import { describe, expect, it } from 'vitest'

import { createCaptureTransport, createLogger } from '../../lib/logger.ts'

import type { EmailMessage, SmtpEmailConfig, SmtpTransport } from './index.ts'
import { SMTP_EMAIL_PROVIDER, createSmtpEmailModule, createSmtpEmailSender } from './index.ts'

const fixedTime = (): Date => new Date('2026-08-12T00:00:00.000Z')

function capture(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = []

  return {
    logger: createLogger({
      level: 'debug',
      transports: [createCaptureTransport((line) => lines.push(line))],
      now: fixedTime,
    }),
    lines,
  }
}

const smtpConfig: SmtpEmailConfig = {
  EMAIL_FROM: 'kelpie@example.com',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'kelpie',
  SMTP_PASSWORD: 'a-real-password',
}

const message: EmailMessage = {
  to: 'reset@example.com',
  subject: 'Reset your password',
  body: 'Follow this link.',
}

function fakeTransport(): { transport: SmtpTransport; calls: unknown[] } {
  const calls: unknown[] = []

  return {
    calls,
    transport: {
      sendMail(mail) {
        calls.push(mail)

        return Promise.resolve({ messageId: 'msg_1' })
      },
    },
  }
}

describe('createSmtpEmailSender', () => {
  it('sends the message through the injected transport', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await sender.send(message)

    expect(calls).toEqual([
      {
        from: smtpConfig.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.body,
      },
    ])
  })

  it('passes the HTML part through when the message carries one', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await sender.send({ ...message, html: '<p>Follow this link.</p>' })

    expect(calls).toEqual([
      {
        from: smtpConfig.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.body,
        html: '<p>Follow this link.</p>',
      },
    ])
  })

  it('wraps a transport failure with context and logs it, rather than leaking it raw', async () => {
    const { logger, lines } = capture()
    const transport: SmtpTransport = {
      sendMail() {
        return Promise.reject(new Error('connection refused'))
      },
    }
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await expect(sender.send(message)).rejects.toThrow(
      `Failed to send email to ${message.to} over SMTP: Error: connection refused`,
    )

    const errorLine = lines.map((line) => JSON.parse(line)).find((line) => line.level === 'error')
    expect(errorLine).toMatchObject({ message: 'smtp send failed', to: message.to })
  })

  it('preserves the original error as the cause', async () => {
    const { logger } = capture()
    const original = new Error('connection refused')
    const transport: SmtpTransport = { sendMail: () => Promise.reject(original) }
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    const thrown: unknown = await sender.send(message).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).cause).toBe(original)
  })
})

describe('createSmtpEmailModule', () => {
  it('has the "smtp-email" id and is structural', () => {
    expect(createSmtpEmailModule().id).toBe('smtp-email')
    expect(createSmtpEmailModule().structural).toBe(true)
  })

  it('exports the provider name it registers under so an assembly can name it', () => {
    // An assembly that hardcodes a string is prone to typos. Importing the
    // constant keeps the module and its callers in step.
    expect(SMTP_EMAIL_PROVIDER).toBe('smtp')
  })
})
