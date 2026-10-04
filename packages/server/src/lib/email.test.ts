import { describe, expect, it } from 'vitest'

import type { EmailMessage } from './email.ts'
import {
  EMAIL_FROM_PROBLEM,
  createLogEmailSender,
  emailConfigSchema,
} from './email.ts'
import { createCaptureTransport, createLogger } from './logger.ts'

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

const message: EmailMessage = {
  to: 'reset@example.com',
  subject: 'Reset your password',
  body: 'Follow this link.',
}

describe('createLogEmailSender', () => {
  it('writes the message to the log instead of sending it', async () => {
    const { logger, lines } = capture()
    const sender = createLogEmailSender(logger, 'kelpie@example.com')

    await sender.send(message)

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      message: 'email not sent: no provider module registered',
      from: 'kelpie@example.com',
      to: message.to,
      subject: message.subject,
    })
  })
})

describe('emailConfigSchema', () => {
  it('requires EMAIL_PROVIDER and EMAIL_FROM', () => {
    const result = emailConfigSchema.safeParse({})

    expect(result.success).toBe(false)
  })

  it('accepts any non-empty provider name', () => {
    // A self-hoster can install a module with any name; core does not
    // hardcode which names are valid.
    expect(emailConfigSchema.safeParse({ EMAIL_PROVIDER: 'log', EMAIL_FROM: 'k@example.com' }).success).toBe(true)
    expect(emailConfigSchema.safeParse({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'k@example.com' }).success).toBe(true)
    expect(emailConfigSchema.safeParse({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'k@example.com' }).success).toBe(true)
  })

  it('rejects an empty provider name', () => {
    expect(emailConfigSchema.safeParse({ EMAIL_PROVIDER: '', EMAIL_FROM: 'k@example.com' }).success).toBe(false)
  })

  it('accepts EMAIL_FROM as one address, or as a name and an address', () => {
    for (const from of ['kelpie@example.com', 'Kelpie <kelpie@example.com>', '"Acme, Inc." <crm@acme.example>']) {
      expect(emailConfigSchema.safeParse({ EMAIL_PROVIDER: 'log', EMAIL_FROM: from }).success).toBe(true)
    }
  })

  it('rejects an EMAIL_FROM that is not a sender, and says which forms are permitted', () => {
    for (const from of ['', 'Kelpie', 'kelpie@localhost', 'a@x.example, b@y.example', 'Kelpie <kelpie>']) {
      const result = emailConfigSchema.safeParse({ EMAIL_PROVIDER: 'log', EMAIL_FROM: from })

      expect(result.success).toBe(false)
      expect(result.error?.issues).toMatchObject([{ path: ['EMAIL_FROM'], message: EMAIL_FROM_PROBLEM }])
    }
  })
})
