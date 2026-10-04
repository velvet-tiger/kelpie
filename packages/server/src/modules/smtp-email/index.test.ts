import type { AddressInfo, Server, Socket } from 'node:net'
import { createServer } from 'node:net'

import nodemailer from 'nodemailer'
import { afterEach, describe, expect, it } from 'vitest'

import { isPermanentEmailError } from '../../lib/email.ts'
import { createCaptureTransport, createLogger } from '../../lib/logger.ts'

import type { EmailMessage, SmtpEmailConfig, SmtpTimeouts, SmtpTransport } from './index.ts'
import {
  SMTP_EMAIL_PROVIDER,
  SMTP_TIMEOUTS,
  createNodemailerTransport,
  createSmtpEmailModule,
  createSmtpEmailSender,
  isPermanentSmtpFailure,
  smtpEmailConfigSchema,
} from './index.ts'

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

  it('sets Reply-To when the message carries one', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await sender.send({ ...message, replyTo: 'lead@example.com' })

    expect(calls).toEqual([
      {
        from: smtpConfig.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.body,
        replyTo: 'lead@example.com',
      },
    ])
  })

  it('puts the message From name on the deployment address', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await sender.send({ ...message, fromName: 'Acme via Kelpie' })

    expect(calls).toEqual([
      {
        from: { name: 'Acme via Kelpie', address: 'kelpie@example.com' },
        to: message.to,
        subject: message.subject,
        text: message.body,
      },
    ])
  })

  it('replaces a name EMAIL_FROM already carries, and keeps its address', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(
      { ...smtpConfig, EMAIL_FROM: 'Kelpie <kelpie@example.com>' },
      logger,
      transport,
    )

    await sender.send({ ...message, fromName: 'Acme via Kelpie' })

    expect(calls).toMatchObject([{ from: { name: 'Acme via Kelpie', address: 'kelpie@example.com' } }])
  })

  it('sends the name EMAIL_FROM carries apart from its address', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(
      { ...smtpConfig, EMAIL_FROM: '"Acme, Inc." <crm@acme.example>' },
      logger,
      transport,
    )

    await sender.send(message)

    expect(calls).toMatchObject([{ from: { name: 'Acme, Inc.', address: 'crm@acme.example' } }])
  })

  it('refuses to build a sender from an EMAIL_FROM that is not an address', () => {
    const { transport } = fakeTransport()
    const { logger } = capture()

    expect(() => createSmtpEmailSender({ ...smtpConfig, EMAIL_FROM: 'the sales team' }, logger, transport)).toThrow(
      'EMAIL_FROM must be an email address',
    )
  })

  it('passes the headers through when the message carries them', async () => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await sender.send({ ...message, headers: { 'Auto-Submitted': 'auto-replied' } })

    expect(calls).toEqual([
      {
        from: smtpConfig.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.body,
        headers: { 'Auto-Submitted': 'auto-replied' },
      },
    ])
  })

  it('writes the headers into the message nodemailer builds', async () => {
    const { logger } = capture()
    let raw = ''
    // nodemailer builds the full message and gives it back, with no connection.
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
    const transport: SmtpTransport = {
      async sendMail(mail) {
        const info = await builder.sendMail(mail)
        raw = info.message.toString()
      },
    }
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await sender.send({
      ...message,
      replyTo: 'ada@example.com',
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
    })

    const [head] = raw.split('\n\n')

    expect(head).toMatch(/^Auto-Submitted: auto-replied$/mu)
    expect(head).toMatch(/^X-Auto-Response-Suppress: OOF, AutoReply$/mu)
    expect(head).toMatch(/^Reply-To: ada@example.com$/mu)
  })

  it.each([
    ['a line break in a value', { 'Auto-Submitted': 'auto-replied\r\nBcc: b@example.com' }],
    ['a line break in a name', { 'X-One\r\nBcc': 'b@example.com' }],
    ['a header the port owns', { 'Reply-To': 'b@example.com' }],
  ])('refuses %s, and sends nothing', async (_label, headers) => {
    const { transport, calls } = fakeTransport()
    const { logger } = capture()
    const sender = createSmtpEmailSender(smtpConfig, logger, transport)

    await expect(sender.send({ ...message, headers })).rejects.toThrow(/^email header/u)
    expect(calls).toEqual([])
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

describe('createNodemailerTransport', () => {
  const sockets: Socket[] = []
  const servers: Server[] = []

  /**
   * A local TCP server that accepts a connection and runs `onConnection` on
   * it. Resolves with the port the operating system gave it.
   */
  function listen(onConnection: (socket: Socket) => void): Promise<number> {
    const server = createServer((socket) => {
      sockets.push(socket)
      socket.on('error', () => undefined)
      onConnection(socket)
    })
    servers.push(server)

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    })
  }

  function localConfig(port: number): SmtpEmailConfig {
    return { EMAIL_FROM: 'kelpie@example.com', SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_SECURE: false }
  }

  /** Sends through a real transport and gives back the failure and how long it took. */
  async function failedSend(
    port: number,
    timeouts: SmtpTimeouts,
  ): Promise<{ thrown: unknown; elapsed: number }> {
    const { logger } = capture()
    const config = localConfig(port)
    const sender = createSmtpEmailSender(config, logger, createNodemailerTransport(config, timeouts))
    const started = Date.now()
    const thrown: unknown = await sender.send(message).catch((error: unknown) => error)

    return { thrown, elapsed: Date.now() - started }
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy()
    }

    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
  })

  it('fails the send when the server accepts the connection and sends no greeting', async () => {
    const port = await listen(() => undefined)

    // The other limits are long, so only the greeting limit can end the send.
    const { thrown, elapsed } = await failedSend(port, { dns: 5_000, connection: 5_000, greeting: 150, socket: 5_000 })

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('Greeting never received')
    expect(elapsed).toBeLessThan(2_000)
  })

  it('fails the send when the server goes silent after its greeting', async () => {
    const port = await listen((socket) => {
      socket.write('220 localhost ESMTP\r\n')
    })

    // The server never answers EHLO, so only the socket limit can end the send.
    const { thrown, elapsed } = await failedSend(port, { dns: 5_000, connection: 5_000, greeting: 5_000, socket: 150 })

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('Timeout')
    expect(elapsed).toBeLessThan(2_000)
  })

  /**
   * A server that speaks enough SMTP to refuse a message. It accepts the
   * greeting, `EHLO` and `MAIL FROM`, and gives `recipientAnswer` to `RCPT TO`.
   */
  function listenAndAnswerRecipient(recipientAnswer: string): Promise<number> {
    return listen((socket) => {
      socket.write('220 localhost ESMTP\r\n')
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\r\n')) {
          if (/^(?:EHLO|HELO)/iu.test(line)) {
            socket.write('250 localhost\r\n')
          } else if (/^MAIL FROM/iu.test(line)) {
            socket.write('250 OK\r\n')
          } else if (/^RCPT TO/iu.test(line)) {
            socket.write(`${recipientAnswer}\r\n`)
          } else if (/^QUIT/iu.test(line)) {
            socket.write('221 Bye\r\n')
          }
        }
      })
    })
  }

  const longTimeouts: SmtpTimeouts = { dns: 5_000, connection: 5_000, greeting: 5_000, socket: 5_000 }

  it('reports a 5xx refusal of the recipient as a permanent failure', async () => {
    const port = await listenAndAnswerRecipient('550 5.1.1 No such user here')

    const { thrown } = await failedSend(port, longTimeouts)

    expect(isPermanentEmailError(thrown)).toBe(true)
    expect((thrown as Error).message).toContain('550 5.1.1 No such user here')
    expect(isPermanentSmtpFailure((thrown as Error).cause)).toBe(true)
  })

  it('reports a 4xx answer to the recipient as a failure to try again', async () => {
    const port = await listenAndAnswerRecipient('450 4.2.0 Greylisted, try again later')

    const { thrown } = await failedSend(port, longTimeouts)

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('450 4.2.0 Greylisted')
    expect(isPermanentEmailError(thrown)).toBe(false)
  })

  it('reports a timeout as a failure to try again', async () => {
    const port = await listen(() => undefined)

    const { thrown } = await failedSend(port, { dns: 5_000, connection: 5_000, greeting: 150, socket: 5_000 })

    expect(thrown).toBeInstanceOf(Error)
    expect(isPermanentEmailError(thrown)).toBe(false)
  })

  it('reports a refused connection as a failure to try again', async () => {
    // A port nothing listens on: the server is opened to get a free port, then closed.
    const port = await listen(() => undefined)
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )

    const { thrown } = await failedSend(port, longTimeouts)

    expect(thrown).toBeInstanceOf(Error)
    expect(isPermanentEmailError(thrown)).toBe(false)
  })

  it('sends with limits short enough for a send inside an HTTP request', () => {
    expect(SMTP_TIMEOUTS).toEqual({ dns: 10_000, connection: 10_000, greeting: 10_000, socket: 30_000 })
  })
})

describe('isPermanentSmtpFailure', () => {
  /** An error with the fields nodemailer puts on its own. */
  function smtpError(code: string, responseCode?: number): Error {
    return Object.assign(new Error('send failed'), { code }, responseCode === undefined ? {} : { responseCode })
  }

  it.each([
    ['a 550 answer to a recipient', smtpError('EENVELOPE', 550)],
    ['a 553 answer to the sender', smtpError('EENVELOPE', 553)],
    ['a 554 answer to the message', smtpError('EMESSAGE', 554)],
    ['an address nodemailer refuses before it sends a command', smtpError('EENVELOPE')],
  ])('is true for %s', (_name, error) => {
    expect(isPermanentSmtpFailure(error)).toBe(true)
  })

  it.each([
    ['a 450 answer to a recipient', smtpError('EENVELOPE', 450)],
    ['a 451 answer to the message', smtpError('EMESSAGE', 451)],
    ['a timeout', smtpError('ETIMEDOUT')],
    ['a lost connection', smtpError('ECONNECTION')],
    ['a socket error', smtpError('ESOCKET')],
    ['a DNS failure', smtpError('EDNS')],
    ['a TLS failure', smtpError('ETLS')],
    ['a 535 answer to the sign-in', smtpError('EAUTH', 535)],
    ['a 554 answer in place of the greeting', smtpError('EPROTOCOL', 554)],
    ['an error with no code', new Error('unknown')],
    ['a value that is not an error', '550 No such user'],
  ])('is false for %s', (_name, error) => {
    expect(isPermanentSmtpFailure(error)).toBe(false)
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

  it('accepts EMAIL_FROM with a display name', () => {
    expect(smtpEmailConfigSchema.parse({ ...baseEnv, EMAIL_FROM: 'Kelpie <kelpie@example.com>' }).EMAIL_FROM).toBe(
      'Kelpie <kelpie@example.com>',
    )
  })

  it('rejects an EMAIL_FROM that is not an address, naming the key', () => {
    const result = smtpEmailConfigSchema.safeParse({ ...baseEnv, EMAIL_FROM: 'the sales team' })

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual(['EMAIL_FROM'])
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
