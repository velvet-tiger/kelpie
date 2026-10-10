import { describe, expect, it } from 'vitest'

import type { EmailMessage } from './email.ts'
import {
  AUTO_GENERATED_EMAIL_HEADERS,
  AUTO_REPLIED_EMAIL_HEADERS,
  EMAIL_FROM_PROBLEM,
  PermanentEmailError,
  completeOnPermanentEmailFailure,
  createLogEmailSender,
  emailConfigSchema,
  emailHeadersProblem,
  isPermanentEmailError,
  logEmailConfigSchema,
  logEmailWritesBody,
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
    const sender = createLogEmailSender(logger, 'kelpie@example.com', { writeBody: true })

    await sender.send(message)

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      message: 'email not sent: no provider module registered',
      from: 'kelpie@example.com',
      to: message.to,
      subject: message.subject,
    })
  })

  it('writes the full plaintext body, and no field the message does not set', async () => {
    const { logger, lines } = capture()
    const sender = createLogEmailSender(logger, 'kelpie@example.com', { writeBody: true })
    const body = 'Use this link:\n\nhttps://kelpie.test/reset?token=abc123\n'

    await sender.send({ ...message, body })

    const line: Record<string, unknown> = JSON.parse(lines[0] ?? '')

    expect(line.body).toBe(body)
    expect(line).not.toHaveProperty('fromName')
    expect(line).not.toHaveProperty('replyTo')
    expect(line).not.toHaveProperty('headers')
    expect(line).not.toHaveProperty('html')
    expect(line).not.toHaveProperty('htmlLength')
  })

  it('writes the From name, the Reply-To, the headers and the length of the HTML part', async () => {
    const { logger, lines } = capture()
    const sender = createLogEmailSender(logger, 'kelpie@example.com', { writeBody: true })
    const html = '<p>Follow this link.</p>'

    await sender.send({
      ...message,
      html,
      replyTo: 'ada@example.com',
      fromName: 'Acme via Kelpie',
      headers: { 'Auto-Submitted': 'auto-replied' },
    })

    const line: Record<string, unknown> = JSON.parse(lines[0] ?? '')

    expect(line).toMatchObject({
      from: 'kelpie@example.com',
      fromName: 'Acme via Kelpie',
      to: message.to,
      replyTo: 'ada@example.com',
      subject: message.subject,
      headers: { 'Auto-Submitted': 'auto-replied' },
      body: message.body,
      htmlLength: html.length,
    })
    // The markup itself is not in the log.
    expect(line).not.toHaveProperty('html')
    expect(lines[0]).not.toContain('<p>')
  })

  it.each([
    ['no options', undefined],
    ['writeBody false', { writeBody: false }],
  ])('writes the length of the body and not the body, with %s', async (_name, options) => {
    const { logger, lines } = capture()
    const sender =
      options === undefined
        ? createLogEmailSender(logger, 'kelpie@example.com')
        : createLogEmailSender(logger, 'kelpie@example.com', options)
    const body = 'Use this link:\n\nhttps://kelpie.test/reset?token=abc123\n'

    await sender.send({ ...message, body, html: '<a href="https://kelpie.test/reset?token=abc123">Reset</a>' })

    const line: Record<string, unknown> = JSON.parse(lines[0] ?? '')

    expect(line).toMatchObject({
      message: 'email not sent: no provider module registered',
      from: 'kelpie@example.com',
      to: message.to,
      subject: message.subject,
      bodyLength: body.length,
    })
    expect(line).not.toHaveProperty('body')
    // No part of the line holds the link or its token.
    expect(lines[0]).not.toContain('token=')
    expect(lines[0]).not.toContain('abc123')
  })
})

describe('logEmailWritesBody', () => {
  it('writes the body in development and test mode when nothing is set', () => {
    expect(logEmailWritesBody('development', undefined)).toBe(true)
    expect(logEmailWritesBody('test', undefined)).toBe(true)
  })

  it('does not write the body in production when nothing is set', () => {
    expect(logEmailWritesBody('production', undefined)).toBe(false)
  })

  it.each(['development', 'test', 'production'] as const)('obeys the setting in %s mode', (runtimeMode) => {
    expect(logEmailWritesBody(runtimeMode, true)).toBe(true)
    expect(logEmailWritesBody(runtimeMode, false)).toBe(false)
  })
})

describe('logEmailConfigSchema', () => {
  it('reads true and false, and accepts no value', () => {
    expect(logEmailConfigSchema.parse({ EMAIL_LOG_BODY: 'true' }).EMAIL_LOG_BODY).toBe(true)
    expect(logEmailConfigSchema.parse({ EMAIL_LOG_BODY: 'false' }).EMAIL_LOG_BODY).toBe(false)
    expect(logEmailConfigSchema.parse({}).EMAIL_LOG_BODY).toBeUndefined()
  })

  it.each(['yes', '1', 'TRUE', ''])('refuses "%s", naming the key', (value) => {
    const result = logEmailConfigSchema.safeParse({ EMAIL_LOG_BODY: value })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['EMAIL_LOG_BODY'])
  })
})

describe('emailHeadersProblem', () => {
  it('accepts no headers, and the headers Kelpie sets', () => {
    expect(emailHeadersProblem(undefined)).toBeUndefined()
    expect(emailHeadersProblem({})).toBeUndefined()
    expect(emailHeadersProblem(AUTO_GENERATED_EMAIL_HEADERS)).toBeUndefined()
    expect(emailHeadersProblem(AUTO_REPLIED_EMAIL_HEADERS)).toBeUndefined()
    expect(emailHeadersProblem({ 'X-Entity-Ref-ID': 'sub_123', 'List-Id': 'Updates <updates.example.com>' })).toBeUndefined()
  })

  it('marks an auto-reply and other automatic mail differently', () => {
    expect(AUTO_REPLIED_EMAIL_HEADERS['Auto-Submitted']).toBe('auto-replied')
    expect(AUTO_GENERATED_EMAIL_HEADERS['Auto-Submitted']).toBe('auto-generated')
  })

  it.each([
    ['a line feed', 'auto-replied\nBcc: b@example.com'],
    ['a carriage return and line feed', 'auto-replied\r\nBcc: b@example.com'],
    ['a carriage return', 'auto-replied\rBcc: b@example.com'],
    ['a null character', 'auto\u0000replied'],
    ['a Unicode line separator', 'auto\u2028replied'],
    ['no text', ''],
    ['only spaces', '   '],
  ])('refuses a value with %s', (_label, value) => {
    expect(emailHeadersProblem({ 'Auto-Submitted': value })).toContain('email header "Auto-Submitted" has an empty value')
  })

  it.each([
    ['a line break', 'X-One\r\nBcc'],
    ['a colon', 'X-One: b'],
    ['a space', 'X One'],
    ['a character outside ASCII', 'X-Caf\u00e9'],
    ['no text', ''],
  ])('refuses a name with %s', (_label, name) => {
    expect(emailHeadersProblem({ [name]: 'value' })).toContain('is not a valid header name')
  })

  it.each(['From', 'to', 'Reply-To', 'SUBJECT', 'Cc', 'Bcc', 'Sender', 'Date', 'Message-ID', 'Content-Type'])(
    'refuses %s, which the port owns',
    (name) => {
      expect(emailHeadersProblem({ [name]: 'value' })).toContain('is set by the email port')
    },
  )

  it('refuses one header given twice in different case', () => {
    expect(emailHeadersProblem({ 'Auto-Submitted': 'auto-replied', 'auto-submitted': 'no' })).toContain(
      'more than once',
    )
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

describe('PermanentEmailError', () => {
  it('is an Error with its own name, and keeps the cause', () => {
    const cause = new Error('550 No such user')
    const error = new PermanentEmailError('refused', { cause })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PermanentEmailError')
    expect(error.message).toBe('refused')
    expect(error.cause).toBe(cause)
  })

  it('is recognised by name, so the class of a second copy of the package is recognised too', () => {
    class PermanentEmailErrorOfAnotherCopy extends Error {
      override readonly name = 'PermanentEmailError'
    }

    expect(isPermanentEmailError(new PermanentEmailError('refused'))).toBe(true)
    expect(isPermanentEmailError(new PermanentEmailErrorOfAnotherCopy('refused'))).toBe(true)
  })

  it('is not recognised in any other thrown value', () => {
    expect(isPermanentEmailError(new Error('connection refused'))).toBe(false)
    expect(isPermanentEmailError({ name: 'PermanentEmailError' })).toBe(false)
    expect(isPermanentEmailError('PermanentEmailError')).toBe(false)
    expect(isPermanentEmailError(undefined)).toBe(false)
  })
})

describe('completeOnPermanentEmailFailure', () => {
  it('returns after a permanent failure, and writes it to the log', async () => {
    const { logger, lines } = capture()

    await completeOnPermanentEmailFailure(logger, () => Promise.reject(new PermanentEmailError('550 No such user')))

    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      {
        level: 'warn',
        message: 'email not retried: the failure is permanent',
        error: 'PermanentEmailError: 550 No such user',
      },
    ])
  })

  it('lets every other error through, so the queue retries the job', async () => {
    const { logger, lines } = capture()
    const error = new Error('connection refused')

    await expect(completeOnPermanentEmailFailure(logger, () => Promise.reject(error))).rejects.toBe(error)
    expect(lines).toEqual([])
  })

  it('returns when the send works', async () => {
    const { logger, lines } = capture()

    await completeOnPermanentEmailFailure(logger, () => Promise.resolve())

    expect(lines).toEqual([])
  })
})
