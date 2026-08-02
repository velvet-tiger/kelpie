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
      logLevel: 'debug',
      email: { EMAIL_PROVIDER: 'log', EMAIL_FROM: 'kelpie@example.com' },
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
})
