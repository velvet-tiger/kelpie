import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ConfigurationError } from './config.ts'
import { fromEnv } from './fromEnv.ts'
import { type KelpieConfigInput, defineKelpieConfig, resolveKelpieConfig } from './kelpieConfigFile.ts'

/**
 * Minimal input that resolves against an empty environment: every value is a
 * literal, no marker is required. Individual tests replace one field with a
 * marker to exercise the resolver.
 */
function baseInput(overrides: Partial<KelpieConfigInput> = {}): KelpieConfigInput {
  return {
    runtimeMode: 'development',
    port: 3000,
    databaseUrl: 'postgres://kelpie:kelpie@localhost:5432/kelpie_dev',
    logLevel: 'debug',
    email: {
      provider: 'log',
      from: 'kelpie@example.com',
    },
    modules: [],
    ...overrides,
  }
}

describe('defineKelpieConfig', () => {
  it('is an identity helper', () => {
    const input = baseInput()

    expect(defineKelpieConfig(input)).toBe(input)
  })
})

describe('resolveKelpieConfig', () => {
  it('resolves literals into a KelpieConfig with rate-limit defaults', () => {
    const config = resolveKelpieConfig(baseInput(), {})

    expect(config).toEqual({
      runtimeMode: 'development',
      port: 3000,
      databaseUrl: 'postgres://kelpie:kelpie@localhost:5432/kelpie_dev',
      logLevel: 'debug',
      email: { EMAIL_PROVIDER: 'log', EMAIL_FROM: 'kelpie@example.com' },
      moduleConfigPath: undefined,
      webBundleDirectory: undefined,
      rateLimit: {
        forms: { limit: 20, windowMs: 60_000 },
        auth: { limit: 10, windowMs: 60_000 },
        loginAccount: { limit: 10, windowMs: 900_000 },
        api: { limit: 600, windowMs: 60_000 },
      },
      trustedProxyHopCount: 0,
    })
  })

  it('lets an env variable override a literal via a marker', () => {
    const input = baseInput({ port: fromEnv('PORT', z.coerce.number(), 3000) })

    expect(resolveKelpieConfig(input, { PORT: '4000' }).port).toBe(4000)
  })

  it('falls back to the marker default when the env variable is missing', () => {
    const input = baseInput({ port: fromEnv('PORT', z.coerce.number(), 3000) })

    expect(resolveKelpieConfig(input, {}).port).toBe(3000)
  })

  it('collects every missing required variable at once', () => {
    const input = baseInput({
      port: fromEnv('PORT', z.coerce.number()),
      databaseUrl: fromEnv('DATABASE_URL', z.string()),
      logLevel: fromEnv('LOG_LEVEL', z.enum(['debug', 'info', 'warn', 'error'])),
    })

    let thrown: unknown
    try {
      resolveKelpieConfig(input, {})
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigurationError)
    if (!(thrown instanceof ConfigurationError)) {
      throw thrown
    }

    const problems = thrown.problems.join('\n')
    expect(problems).toContain('PORT')
    expect(problems).toContain('DATABASE_URL')
    expect(problems).toContain('LOG_LEVEL')
  })

  it('reports parse failures with the config-path prefix', () => {
    const input = baseInput({ port: fromEnv('PORT', z.coerce.number().int().positive()) })

    let thrown: unknown
    try {
      resolveKelpieConfig(input, { PORT: 'nope' })
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigurationError)
    if (!(thrown instanceof ConfigurationError)) {
      throw thrown
    }

    expect(thrown.problems.join('\n')).toContain('port:')
  })

  describe('email discriminator', () => {
    it('produces the log-shape when provider is "log"', () => {
      const config = resolveKelpieConfig(baseInput(), {})

      expect(config.email).toEqual({ EMAIL_PROVIDER: 'log', EMAIL_FROM: 'kelpie@example.com' })
    })

    it('produces the smtp-shape when every smtp field is present', () => {
      const input = baseInput({
        email: {
          provider: 'smtp',
          from: 'kelpie@example.com',
          smtp: {
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'kelpie',
            password: 'a-real-password',
          },
        },
      })

      expect(resolveKelpieConfig(input, {}).email).toEqual({
        EMAIL_PROVIDER: 'smtp',
        EMAIL_FROM: 'kelpie@example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_USER: 'kelpie',
        SMTP_PASSWORD: 'a-real-password',
      })
    })

    it('reports every missing smtp field when provider is "smtp"', () => {
      const input = baseInput({
        email: { provider: 'smtp', from: 'kelpie@example.com' },
      })

      let thrown: unknown
      try {
        resolveKelpieConfig(input, {})
      } catch (error: unknown) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(ConfigurationError)
      if (!(thrown instanceof ConfigurationError)) {
        throw thrown
      }

      const problems = thrown.problems.join('\n')
      expect(problems).toContain('email.smtp.host')
      expect(problems).toContain('email.smtp.port')
      expect(problems).toContain('email.smtp.secure')
      expect(problems).toContain('email.smtp.user')
      expect(problems).toContain('email.smtp.password')
    })
  })

  it('honours a rateLimit override in seconds', () => {
    const input = baseInput({
      rateLimit: { forms: { limit: 5, windowSeconds: 120 } },
    })

    expect(resolveKelpieConfig(input, {}).rateLimit.forms).toEqual({ limit: 5, windowMs: 120_000 })
  })

  it('uses the trustedProxyHopCount default of 0 when unset', () => {
    expect(resolveKelpieConfig(baseInput(), {}).trustedProxyHopCount).toBe(0)
  })
})
