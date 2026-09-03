import { describe, expect, it } from 'vitest'

import { createCaptureTransport, createLogger } from '../../lib/logger.ts'

import type { EmailMessage, SmtpEmailConfig, SmtpTransport } from './index.ts'
import { SMTP_EMAIL_PROVIDER, createSmtpEmailModule, createSmtpEmailSender, smtpEmailConfigSchema } from './index.ts'

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

  it('sends over a transport built from a config with no SMTP credentials, for an unauthenticated local relay', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const unauthenticatedConfig: SmtpEmailConfig = {
      EMAIL_FROM: smtpConfig.EMAIL_FROM,
      SMTP_HOST: smtpConfig.SMTP_HOST,
      SMTP_PORT: smtpConfig.SMTP_PORT,
      SMTP_SECURE: smtpConfig.SMTP_SECURE,
    }
    const sender = createSmtpEmailSender(unauthenticatedConfig, logger, transport)

    await sender.send(message)

    expect(calls).toEqual([
      {
        from: unauthenticatedConfig.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.body,
      },
    ])
  })
})

describe('smtpEmailConfigSchema', () => {
  const baseEnv = {
    EMAIL_FROM: 'kelpie@example.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
  } as const

  it('accepts a config with both SMTP_USER and SMTP_PASSWORD set', () => {
    const parsed = smtpEmailConfigSchema.parse({
      ...baseEnv,
      SMTP_USER: 'kelpie',
      SMTP_PASSWORD: 'a-real-password',
    })

    expect(parsed.SMTP_USER).toBe('kelpie')
    expect(parsed.SMTP_PASSWORD).toBe('a-real-password')
  })

  it('accepts a config with neither SMTP_USER nor SMTP_PASSWORD, for an unauthenticated relay', () => {
    const parsed = smtpEmailConfigSchema.parse(baseEnv)

    expect(parsed.SMTP_USER).toBeUndefined()
    expect(parsed.SMTP_PASSWORD).toBeUndefined()
  })

  it('rejects a config that sets SMTP_USER without SMTP_PASSWORD, naming both keys', () => {
    const result = smtpEmailConfigSchema.safeParse({ ...baseEnv, SMTP_USER: 'kelpie' })

    expect(result.success).toBe(false)

    if (result.success) {
      throw new Error('expected the parse to fail')
    }

    const keys = result.error.issues.map((issue) => issue.path[0])
    expect(keys).toContain('SMTP_USER')
    expect(keys).toContain('SMTP_PASSWORD')
  })

  it('rejects a config that sets SMTP_PASSWORD without SMTP_USER, naming both keys', () => {
    const result = smtpEmailConfigSchema.safeParse({ ...baseEnv, SMTP_PASSWORD: 'a-real-password' })

    expect(result.success).toBe(false)

    if (result.success) {
      throw new Error('expected the parse to fail')
    }

    const keys = result.error.issues.map((issue) => issue.path[0])
    expect(keys).toContain('SMTP_USER')
    expect(keys).toContain('SMTP_PASSWORD')
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
