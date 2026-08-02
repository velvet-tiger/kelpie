import { describe, expect, it } from 'vitest'

import { createLogger } from './logger.ts'

const fixedTime = (): Date => new Date('2026-08-02T00:00:00.000Z')

function capture(level: Parameters<typeof createLogger>[0]): {
  logger: ReturnType<typeof createLogger>
  lines: string[]
} {
  const lines: string[] = []

  return { logger: createLogger(level, (line) => lines.push(line), fixedTime), lines }
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

  it('does not let a field overwrite the envelope', () => {
    const { logger, lines } = capture('debug')

    logger.info('real message', { message: 'impostor', level: 'error', time: 'yesterday' })

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-08-02T00:00:00.000Z',
      level: 'info',
      message: 'real message',
    })
  })
})
