import type { AddressInfo, Server, Socket } from 'node:net'
import { createServer } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createCaptureTransport, createLogger } from '../../lib/logger.ts'

import type { EmailMessage, SmtpEmailConfig, SmtpTimeouts, SmtpTransport } from './index.ts'
import {
  SMTP_EMAIL_PROVIDER,
  SMTP_TIMEOUTS,
  createNodemailerTransport,
  createSmtpEmailModule,
  createSmtpEmailSender,
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

  it('sends with limits short enough for a send inside an HTTP request', () => {
    expect(SMTP_TIMEOUTS).toEqual({ dns: 10_000, connection: 10_000, greeting: 10_000, socket: 30_000 })
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
