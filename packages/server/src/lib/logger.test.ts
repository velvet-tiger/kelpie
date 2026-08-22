import { describe, expect, it } from 'vitest'

import {
  createCaptureTransport,
  createLogger,
  createStdoutTransport,
  createTransportForDestination,
} from './logger.ts'
import type { CreateLoggerOptions, LoggingDestination } from './logger.ts'

const fixedTime = (): Date => new Date('2026-08-02T00:00:00.000Z')

function capture(level: CreateLoggerOptions['level']): {
  logger: ReturnType<typeof createLogger>
  lines: string[]
} {
  const lines: string[] = []

  return {
    logger: createLogger({
      level,
      transports: [createCaptureTransport((line) => lines.push(line))],
      now: fixedTime,
    }),
    lines,
  }
}

describe('createLogger', () => {
  it('writes one JSON line per call', () => {
    const { logger, lines } = capture('debug')

    logger.info('listening', { port: 3000 })

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-08-02T00:00:00.000Z',
      level: 'info',
      message: 'listening',
      port: 3000,
    })
  })

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture('warn')

    logger.debug('noisy')
    logger.info('also noisy')
    logger.warn('worth reading')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '').message).toBe('worth reading')
  })

  it('stamps child fields onto every line', () => {
    const { logger, lines } = capture('debug')

    logger.child({ requestId: 'req_1' }).error('unhandled error', { path: '/v1/people' })

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ requestId: 'req_1', path: '/v1/people' })
  })

  it('does not let a per-call field overwrite the envelope', () => {
    const { logger, lines } = capture('debug')

    logger.info('real message', { message: 'impostor', level: 'error', time: 'yesterday' })

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-08-02T00:00:00.000Z',
      level: 'info',
      message: 'real message',
    })
  })

  it('does not let a bound child field overwrite the envelope', () => {
    const { logger, lines } = capture('debug')

    logger
      .child({ message: 'impostor', level: 'error', time: 'yesterday' })
      .info('real message')

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-08-02T00:00:00.000Z',
      level: 'info',
      message: 'real message',
    })
  })

  it('fans one line out to every transport', () => {
    const first: string[] = []
    const second: string[] = []
    const logger = createLogger({
      level: 'debug',
      transports: [
        createCaptureTransport((line) => first.push(line)),
        createCaptureTransport((line) => second.push(line)),
      ],
      now: fixedTime,
    })

    logger.info('hello')

    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('writes nothing when the transports list is empty', () => {
    const logger = createLogger({ level: 'debug', transports: [], now: fixedTime })

    expect(() => logger.info('ignored')).not.toThrow()
  })
})

describe('createStdoutTransport', () => {
  it('writes each line and a trailing newline to stdout', () => {
    const captured: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const logger = createLogger({
        level: 'debug',
        transports: [createStdoutTransport()],
        now: fixedTime,
      })
      logger.info('stdout works', { port: 3000 })
    } finally {
      process.stdout.write = originalWrite
    }

    expect(captured).toHaveLength(1)
    const line = captured[0] ?? ''
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line.trimEnd())).toEqual({
      time: '2026-08-02T00:00:00.000Z',
      level: 'info',
      message: 'stdout works',
      port: 3000,
    })
  })
})

describe('createTransportForDestination', () => {
  it('builds a stdout transport for kind "stdout"', () => {
    const destination: LoggingDestination = { kind: 'stdout' }
    const captured: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const logger = createLogger({
        level: 'debug',
        transports: [createTransportForDestination(destination)],
        now: fixedTime,
      })
      logger.info('via destination')
    } finally {
      process.stdout.write = originalWrite
    }

    expect(captured).toHaveLength(1)
    expect(JSON.parse((captured[0] ?? '').trimEnd()).message).toBe('via destination')
  })
})
