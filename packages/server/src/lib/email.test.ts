import { describe, expect, it } from 'vitest'

import type { EmailMessage } from './email.ts'
import { createEmailSender, createSmtpEmailSender } from './email.ts'
import type { SmtpTransport } from './email.ts'
import { createLogger } from './logger.ts'

const fixedTime = (): Date => new Date('2026-08-12T00:00:00.000Z')

function capture(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = []

  return { logger: createLogger('debug', (line) => lines.push(line), fixedTime), lines }
}

const smtpConfig = {
  EMAIL_PROVIDER: 'smtp' as const,
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

describe('createEmailSender', () => {
  it('routes to the smtp sender without opening a connection', () => {
    const { logger } = capture()

    const sender = createEmailSender(smtpConfig, logger)

    expect(typeof sender.send).toBe('function')
  })

  it('routes to the log sender', async () => {
    const { logger, lines } = capture()

    const sender = createEmailSender({ EMAIL_PROVIDER: 'log', EMAIL_FROM: 'kelpie@example.com' }, logger)
    await sender.send(message)

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ message: 'email not sent: provider is "log"', to: message.to })
  })
})
