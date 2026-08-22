import { describe, expect, it } from 'vitest'

import { ConfigurationError, loadConfig } from './config.ts'

const validEnvironment = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgres://kelpie:kelpie@localhost:5432/kelpie_dev',
  LOG_LEVEL: 'debug',
  EMAIL_PROVIDER: 'log',
  EMAIL_FROM: 'kelpie@example.com',
}

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    expect(loadConfig(validEnvironment)).toEqual({
      runtimeMode: 'development',
      port: 3000,
      databaseUrl: 'postgres://kelpie:kelpie@localhost:5432/kelpie_dev',
      logging: {
        level: 'debug',
        destinations: [{ kind: 'stdout' }],
      },
      email: { EMAIL_PROVIDER: 'log', EMAIL_FROM: 'kelpie@example.com' },
      rateLimit: {
        forms: { limit: 20, windowMs: 60_000 },
        auth: { limit: 10, windowMs: 60_000 },
        loginAccount: { limit: 10, windowMs: 900_000 },
        api: { limit: 600, windowMs: 60_000 },
      },
      trustedProxyHopCount: 0,
      env: validEnvironment,
    })
  })

  it('reports every missing variable at once', () => {
    let thrown: unknown

    try {
      loadConfig({})
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigurationError)
    if (!(thrown instanceof ConfigurationError)) {
      throw thrown
    }

    const problems = thrown.problems.join('\n')
    expect(problems).toContain('NODE_ENV')
    expect(problems).toContain('PORT')
    expect(problems).toContain('DATABASE_URL')
    expect(problems).toContain('LOG_LEVEL')
    expect(problems).toContain('EMAIL_PROVIDER')
  })

  it('rejects a non-postgres database url', () => {
    expect(() => loadConfig({ ...validEnvironment, DATABASE_URL: 'mysql://localhost/kelpie' })).toThrow(
      ConfigurationError,
    )
  })

  it('rejects a port that is not a number', () => {
    expect(() => loadConfig({ ...validEnvironment, PORT: 'http' })).toThrow(ConfigurationError)
  })

  it('rejects an unknown log level rather than falling back', () => {
    expect(() => loadConfig({ ...validEnvironment, LOG_LEVEL: 'verbose' })).toThrow(ConfigurationError)
  })

  describe('EMAIL_PROVIDER=smtp', () => {
    const smtpEnvironment = {
      ...validEnvironment,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'kelpie',
      SMTP_PASSWORD: 'a-real-password',
    }

    it('parses a complete smtp environment, coercing the port and the boolean', () => {
      expect(loadConfig(smtpEnvironment).email).toEqual({
        EMAIL_PROVIDER: 'smtp',
        EMAIL_FROM: 'kelpie@example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_USER: 'kelpie',
        SMTP_PASSWORD: 'a-real-password',
      })
    })

    it('coerces SMTP_SECURE=true', () => {
      expect(loadConfig({ ...smtpEnvironment, SMTP_SECURE: 'true' }).email).toMatchObject({ SMTP_SECURE: true })
    })

    it('reports every missing SMTP_* variable at once, alongside the rest', () => {
      let thrown: unknown

      try {
        loadConfig({ ...validEnvironment, EMAIL_PROVIDER: 'smtp' })
      } catch (error: unknown) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(ConfigurationError)
      if (!(thrown instanceof ConfigurationError)) {
        throw thrown
      }

      const problems = thrown.problems.join('\n')
      expect(problems).toContain('SMTP_HOST')
      expect(problems).toContain('SMTP_PORT')
      expect(problems).toContain('SMTP_SECURE')
      expect(problems).toContain('SMTP_USER')
      expect(problems).toContain('SMTP_PASSWORD')
    })

    it('rejects a non-numeric SMTP_PORT', () => {
      expect(() => loadConfig({ ...smtpEnvironment, SMTP_PORT: 'default' })).toThrow(ConfigurationError)
    })

    it('rejects an SMTP_SECURE value that is not "true" or "false"', () => {
      expect(() => loadConfig({ ...smtpEnvironment, SMTP_SECURE: 'yes' })).toThrow(ConfigurationError)
    })
  })
})
