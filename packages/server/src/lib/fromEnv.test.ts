import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { fromEnv, isFromEnvMarker, resolveMarker, resolveMarkers } from './fromEnv.ts'

describe('fromEnv', () => {
  it('produces a marker with no default', () => {
    const marker = fromEnv('PORT', z.coerce.number())

    expect(isFromEnvMarker(marker)).toBe(true)
    expect(marker.envKey).toBe('PORT')
    expect(marker.hasDefault).toBe(false)
    expect(marker.defaultValue).toBeUndefined()
  })

  it('produces a marker with a default', () => {
    const marker = fromEnv('PORT', z.coerce.number(), 3000)

    expect(marker.hasDefault).toBe(true)
    expect(marker.defaultValue).toBe(3000)
  })

  it('records an explicit undefined default (distinguishes "unset" from "no default")', () => {
    const marker = fromEnv<string | undefined>('WEB_BUNDLE_DIR', z.string().optional(), undefined)

    expect(marker.hasDefault).toBe(true)
    expect(marker.defaultValue).toBeUndefined()
  })
})

describe('isFromEnvMarker', () => {
  it.each([undefined, null, 'string', 42, {}, { envKey: 'X' }])('rejects %p', (value) => {
    expect(isFromEnvMarker(value)).toBe(false)
  })

  it('accepts a real marker', () => {
    expect(isFromEnvMarker(fromEnv('X', z.string()))).toBe(true)
  })
})

describe('resolveMarker', () => {
  it('returns the env-parsed value when the variable is set', () => {
    const marker = fromEnv('PORT', z.coerce.number(), 3000)

    const result = resolveMarker(marker, { PORT: '4000' }, 'port')

    expect(result).toEqual({ value: 4000, problems: [] })
  })

  it('returns the default when the variable is missing', () => {
    const marker = fromEnv('PORT', z.coerce.number(), 3000)

    const result = resolveMarker(marker, {}, 'port')

    expect(result).toEqual({ value: 3000, problems: [] })
  })

  it('reports a problem when required and missing', () => {
    const marker = fromEnv('PORT', z.coerce.number())

    const result = resolveMarker(marker, {}, 'port')

    expect(result.value).toBeUndefined()
    expect(result.problems).toEqual([{ path: 'port', message: 'PORT is required' }])
  })

  it('reports parse failures with the env-key prefix', () => {
    const marker = fromEnv('PORT', z.coerce.number().int().positive())

    const result = resolveMarker(marker, { PORT: 'nope' }, 'port')

    expect(result.value).toBeUndefined()
    expect(result.problems).toHaveLength(1)
    const problem = result.problems[0]
    if (problem === undefined) {
      throw new Error('expected at least one problem')
    }
    expect(problem.path).toBe('port')
    expect(problem.message).toContain('PORT:')
  })
})

describe('resolveMarkers', () => {
  it('walks nested objects and replaces markers, preserving literals', () => {
    const input = {
      port: fromEnv('PORT', z.coerce.number(), 3000),
      logLevel: 'info',
      email: {
        from: fromEnv('EMAIL_FROM', z.string(), 'kelpie@example.com'),
        provider: 'log',
      },
    }

    const result = resolveMarkers(input, { PORT: '4000' })

    expect(result.problems).toEqual([])
    expect(result.value).toEqual({
      port: 4000,
      logLevel: 'info',
      email: { from: 'kelpie@example.com', provider: 'log' },
    })
  })

  it('collects problems from every marker rather than stopping at the first', () => {
    const input = {
      port: fromEnv('PORT', z.coerce.number()),
      databaseUrl: fromEnv('DATABASE_URL', z.string()),
    }

    const result = resolveMarkers(input, {})

    const messages = result.problems.map((problem) => problem.message)
    expect(messages).toContain('PORT is required')
    expect(messages).toContain('DATABASE_URL is required')
  })

  it('walks arrays', () => {
    const input = { hosts: [fromEnv('HOST_A', z.string(), 'a'), fromEnv('HOST_B', z.string(), 'b')] }

    const result = resolveMarkers(input, { HOST_A: 'one' })

    expect(result.value).toEqual({ hosts: ['one', 'b'] })
  })
})
