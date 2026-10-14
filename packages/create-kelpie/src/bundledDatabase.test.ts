import { describe, expect, it } from 'vitest'

import { bundledDatabaseFor } from './bundledDatabase.ts'
import { ScaffoldError } from './errors.ts'

/** The message of the `ScaffoldError` the call throws. Fails the test on anything else. */
function refusal(databaseUrl: string, databasePort = 5432): string {
  try {
    bundledDatabaseFor(databaseUrl, databasePort)
  } catch (error) {
    if (error instanceof ScaffoldError) {
      return error.message
    }

    throw error
  }

  throw new Error(`expected ${databaseUrl} to be refused`)
}

describe('bundledDatabaseFor', () => {
  it('reads the user, password and database name of the default connection string', () => {
    expect(bundledDatabaseFor('postgres://kelpie:kelpie@localhost:5432/kelpie', 5432)).toEqual({
      user: 'kelpie',
      password: 'kelpie',
      name: 'kelpie',
    })
  })

  it('reads a custom user, password and database name', () => {
    expect(bundledDatabaseFor('postgresql://demo_user:s3cret.pw~-_@127.0.0.1:5462/kelpie_demo', 5462)).toEqual({
      user: 'demo_user',
      password: 's3cret.pw~-_',
      name: 'kelpie_demo',
    })
  })

  it('accepts the host in any case', () => {
    expect(bundledDatabaseFor('postgres://kelpie:kelpie@LOCALHOST:5432/kelpie', 5432).user).toBe('kelpie')
  })

  it('ignores a query string, which DATABASE_URL may need', () => {
    expect(bundledDatabaseFor('postgres://kelpie:kelpie@localhost:5432/kelpie?sslmode=disable', 5432).name).toBe('kelpie')
  })

  it('reads a URL with no port as the Postgres default, 5432', () => {
    expect(bundledDatabaseFor('postgres://kelpie:kelpie@localhost/kelpie', 5432).name).toBe('kelpie')
  })

  it('decodes percent-encoding before it checks a part', () => {
    expect(bundledDatabaseFor('postgres://kelpie:pass%2Dword@localhost:5432/kelpie', 5432).password).toBe('pass-word')
  })

  it('refuses a URL that does not parse, without repeating it', () => {
    const message = refusal('not a url with a s3cret')

    expect(message).toContain('not a valid URL')
    expect(message).not.toContain('s3cret')
  })

  it('refuses a scheme that is not Postgres', () => {
    expect(refusal('mysql://kelpie:kelpie@localhost:5432/kelpie')).toContain('postgres://')
  })

  it.each(['db.example', '10.0.0.5', '[::1]'])('refuses the host %s, which the bundled Postgres does not listen on', (host) => {
    const message = refusal(`postgres://kelpie:kelpie@${host}:5432/kelpie`)

    expect(message).toContain('127.0.0.1')
    expect(message).toContain('--no-docker')
  })

  it('refuses a URL port that is not the published port, and names both', () => {
    const message = refusal('postgres://kelpie:kelpie@localhost:5462/kelpie', 5432)

    expect(message).toContain('5462')
    expect(message).toContain('--database-port 5462')
  })

  it.each([
    ['user', 'postgres://:kelpie@localhost:5432/kelpie'],
    ['password', 'postgres://kelpie@localhost:5432/kelpie'],
    ['database name', 'postgres://kelpie:kelpie@localhost:5432/'],
  ])('refuses a URL with no %s', (label, databaseUrl) => {
    expect(refusal(databaseUrl)).toContain(`no ${label}`)
  })

  it.each([
    ['user', "postgres://bad%27user:kelpie@localhost:5432/kelpie"],
    ['user', 'postgres://bad-user:kelpie@localhost:5432/kelpie'],
    ['database name', 'postgres://kelpie:kelpie@localhost:5432/kelpie%3Brm%20-rf'],
    ['database name', 'postgres://kelpie:kelpie@localhost:5432/a/b'],
  ])('refuses a %s that would need quoting: %s', (label, databaseUrl) => {
    expect(refusal(databaseUrl)).toContain(`The ${label} in --database-url may use only`)
  })

  it.each(['pa%24%24word', 'pa%27ss', 'pa%23ss', 'pa%20ss'])(
    'refuses the password %s, which .env would need to quote, and does not repeat it',
    (password) => {
      const message = refusal(`postgres://kelpie:${password}@localhost:5432/kelpie`)

      expect(message).toContain('The password in --database-url may use only')
      expect(message).not.toContain(decodeURIComponent(password))
    },
  )

  it('refuses broken percent-encoding', () => {
    expect(refusal('postgres://kelpie:bad%E0%A4@localhost:5432/kelpie')).toContain('broken percent-encoding')
  })
})
