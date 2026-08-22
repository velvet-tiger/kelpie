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
    logging: {
      level: 'debug',
      destinations: [{ kind: 'stdout' }],
    },
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
      logging: {
        level: 'debug',
        destinations: [{ kind: 'stdout' }],
      },
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
      env: {},
      appBaseUrl: undefined,
      secretEncryption: undefined,
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
      logging: {
        level: fromEnv('LOG_LEVEL', z.enum(['debug', 'info', 'warn', 'error'])),
        destinations: [{ kind: 'stdout' }],
      },
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

  describe('email', () => {
    it('reshapes `provider` and `from` into the EmailConfig core wants', () => {
      const config = resolveKelpieConfig(baseInput(), {})

      expect(config.email).toEqual({ EMAIL_PROVIDER: 'log', EMAIL_FROM: 'kelpie@example.com' })
    })

    it('resolves the provider name from a fromEnv marker', () => {
      const input = baseInput({
        email: {
          provider: fromEnv('EMAIL_PROVIDER', z.string().min(1)),
          from: 'kelpie@example.com',
        },
      })

      expect(resolveKelpieConfig(input, { EMAIL_PROVIDER: 'smtp' }).email.EMAIL_PROVIDER).toBe('smtp')
    })

    it('reports a missing `provider` at the email.provider path', () => {
      const input = baseInput({
        email: {
          provider: fromEnv('EMAIL_PROVIDER', z.string().min(1)),
          from: 'kelpie@example.com',
        },
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

      expect(thrown.problems.join('\n')).toContain('email.provider')
    })

    it('reports a missing `from` at the email.from path', () => {
      const input = baseInput({
        email: {
          provider: 'log',
          from: fromEnv('EMAIL_FROM', z.string().min(1)),
        },
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

      expect(thrown.problems.join('\n')).toContain('email.from')
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

  describe('env merge', () => {
    it('passes process.env through unchanged when no env section is declared', () => {
      const config = resolveKelpieConfig(baseInput(), { SECRET_ENCRYPTION_KEY: 'from-env' })

      expect(config.env.SECRET_ENCRYPTION_KEY).toBe('from-env')
    })

    it('lets a literal in kelpie.config.ts override process.env for one key', () => {
      const input = baseInput({ env: { AUTH_TTL: '3600' } })

      const config = resolveKelpieConfig(input, { AUTH_TTL: '7200', OTHER: 'kept' })

      expect(config.env.AUTH_TTL).toBe('3600')
      expect(config.env.OTHER).toBe('kept')
    })

    it('resolves a fromEnv marker in the env section', () => {
      const input = baseInput({
        env: { SECRET_ENCRYPTION_KEY: fromEnv('SECRET_ENCRYPTION_KEY', z.string()) },
      })

      const config = resolveKelpieConfig(input, { SECRET_ENCRYPTION_KEY: 'from-env' })

      expect(config.env.SECRET_ENCRYPTION_KEY).toBe('from-env')
    })

    it('reports a required env marker whose var is missing', () => {
      const input = baseInput({
        env: { SECRET_ENCRYPTION_KEY: fromEnv('SECRET_ENCRYPTION_KEY', z.string()) },
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
      expect(thrown.problems.join('\n')).toContain('SECRET_ENCRYPTION_KEY')
    })

    it('falls back to a marker default when the var is missing', () => {
      const input = baseInput({
        env: { AUTH_TTL: fromEnv<string | undefined>('AUTH_TTL', z.string().optional(), '3600') },
      })

      expect(resolveKelpieConfig(input, {}).env.AUTH_TTL).toBe('3600')
    })
  })

  describe('appBaseUrl', () => {
    it('is undefined when the input omits it', () => {
      expect(resolveKelpieConfig(baseInput(), {}).appBaseUrl).toBeUndefined()
    })

    it('resolves a literal', () => {
      const input = baseInput({ appBaseUrl: 'https://crm.example.com' })

      expect(resolveKelpieConfig(input, {}).appBaseUrl).toBe('https://crm.example.com')
    })

    it('resolves a fromEnv marker', () => {
      const input = baseInput({ appBaseUrl: fromEnv('APP_BASE_URL', z.string().url()) })

      const config = resolveKelpieConfig(input, { APP_BASE_URL: 'https://crm.example.com' })

      expect(config.appBaseUrl).toBe('https://crm.example.com')
    })

    it('reports a required marker whose var is missing', () => {
      const input = baseInput({ appBaseUrl: fromEnv('APP_BASE_URL', z.string().url()) })

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
      expect(thrown.problems.join('\n')).toContain('APP_BASE_URL')
    })
  })

  describe('secretEncryption', () => {
    const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    const OLD = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='

    it('is undefined when the input omits it', () => {
      expect(resolveKelpieConfig(baseInput(), {}).secretEncryption).toBeUndefined()
    })

    it('resolves the key alone into the SecretEncryptionConfig shape', () => {
      const input = baseInput({ secretEncryption: { key: KEY } })

      expect(resolveKelpieConfig(input, {}).secretEncryption).toEqual({ SECRET_ENCRYPTION_KEY: KEY })
    })

    it('resolves both key and previousKey when set', () => {
      const input = baseInput({ secretEncryption: { key: KEY, previousKey: OLD } })

      expect(resolveKelpieConfig(input, {}).secretEncryption).toEqual({
        SECRET_ENCRYPTION_KEY: KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: OLD,
      })
    })

    it('resolves fromEnv markers for both keys', () => {
      const input = baseInput({
        secretEncryption: {
          key: fromEnv('SECRET_ENCRYPTION_KEY', z.string()),
          previousKey: fromEnv<string | undefined>(
            'SECRET_ENCRYPTION_KEY_PREVIOUS',
            z.string().optional(),
          ),
        },
      })

      const config = resolveKelpieConfig(input, {
        SECRET_ENCRYPTION_KEY: KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: OLD,
      })

      expect(config.secretEncryption).toEqual({
        SECRET_ENCRYPTION_KEY: KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: OLD,
      })
    })

    it('reports a required key marker whose var is missing', () => {
      const input = baseInput({
        secretEncryption: { key: fromEnv('SECRET_ENCRYPTION_KEY', z.string()) },
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
      expect(thrown.problems.join('\n')).toContain('SECRET_ENCRYPTION_KEY')
    })
  })

  describe('logging', () => {
    it('resolves a level literal and the declared destinations', () => {
      const config = resolveKelpieConfig(baseInput(), {})

      expect(config.logging).toEqual({
        level: 'debug',
        destinations: [{ kind: 'stdout' }],
      })
    })

    it('reads the level from LOG_LEVEL through a marker', () => {
      const input = baseInput({
        logging: {
          level: fromEnv('LOG_LEVEL', z.enum(['debug', 'info', 'warn', 'error']), 'info'),
          destinations: [{ kind: 'stdout' }],
        },
      })

      expect(resolveKelpieConfig(input, { LOG_LEVEL: 'warn' }).logging.level).toBe('warn')
    })

    it('falls back to the marker default when LOG_LEVEL is unset', () => {
      const input = baseInput({
        logging: {
          level: fromEnv('LOG_LEVEL', z.enum(['debug', 'info', 'warn', 'error']), 'info'),
          destinations: [{ kind: 'stdout' }],
        },
      })

      expect(resolveKelpieConfig(input, {}).logging.level).toBe('info')
    })
  })
})
