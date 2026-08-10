import { describe, expect, it } from 'vitest'

import {
  bundledDatabaseUrl,
  generateSecretEncryptionKey,
  parseArguments,
  readOwnVersion,
  resolveOptions,
  toPackageName,
} from './options.ts'
import { ScaffoldError } from './scaffold.ts'

describe('parseArguments', () => {
  it('takes the directory as a positional and the rest as flags', () => {
    const parsed = parseArguments(['crm', '--name', 'acme', '--database-url', 'postgres://db/x', '--port', '4000'])

    expect(parsed.directory).toBe('crm')
    expect(parsed.name).toBe('acme')
    expect(parsed.databaseUrl).toBe('postgres://db/x')
    expect(parsed.port).toBe(4000)
  })

  it('defaults the ports', () => {
    const parsed = parseArguments([])

    expect(parsed.port).toBe(3000)
    expect(parsed.webPort).toBe(5173)
    expect(parsed.databasePort).toBe(5432)
  })

  it('leaves docker undecided when neither flag is given, so a prompt can decide', () => {
    expect(parseArguments([]).docker).toBeUndefined()
    expect(parseArguments(['--docker']).docker).toBe(true)
    expect(parseArguments(['--no-docker']).docker).toBe(false)
  })

  it('rejects the two docker flags together rather than picking one', () => {
    expect(() => parseArguments(['--docker', '--no-docker'])).toThrow(ScaffoldError)
  })

  it('rejects a port that is not one', () => {
    expect(() => parseArguments(['--port', 'http'])).toThrow(/port number/)
    expect(() => parseArguments(['--port', '0'])).toThrow(/port number/)
    expect(() => parseArguments(['--port', '70000'])).toThrow(/port number/)
  })
})

describe('toPackageName', () => {
  it('lowercases and replaces what npm will not take', () => {
    expect(toPackageName('Acme CRM')).toBe('acme-crm')
    expect(toPackageName('My_Project')).toBe('my_project')
    expect(toPackageName('.hidden')).toBe('hidden')
  })

  it('falls back rather than producing an invalid name', () => {
    expect(toPackageName('---')).toBe('kelpie')
    expect(toPackageName('')).toBe('kelpie')
  })
})

describe('generateSecretEncryptionKey', () => {
  it('produces the 32 bytes of base64 the service requires', () => {
    expect(Buffer.from(generateSecretEncryptionKey(), 'base64')).toHaveLength(32)
  })

  it('produces a different key every time, so two installs never share one', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateSecretEncryptionKey()))

    expect(keys.size).toBe(20)
  })
})

describe('readOwnVersion', () => {
  it('reads this package version, which is what a scaffold pins', () => {
    expect(readOwnVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('resolveOptions', () => {
  it('refuses to invent answers when there is no terminal to ask on', async () => {
    await expect(resolveOptions(parseArguments([]), false)).rejects.toThrow(/no terminal/)
  })

  it('takes the defaults under --yes, pointing at the bundled Postgres', async () => {
    const options = await resolveOptions(parseArguments(['crm', '--yes']), false)

    expect(options.projectName).toBe('crm')
    expect(options.docker).toBe(true)
    expect(options.databaseUrl).toBe(bundledDatabaseUrl(5432))
    expect(options.coreVersion).toBe(readOwnVersion())
    expect(Buffer.from(options.secretEncryptionKey, 'base64')).toHaveLength(32)
  })

  it('keeps an explicit database url and database port in step', async () => {
    const explicit = await resolveOptions(parseArguments(['crm', '--yes', '--database-url', 'postgres://x/y']), false)

    expect(explicit.databaseUrl).toBe('postgres://x/y')

    const bundled = await resolveOptions(parseArguments(['crm', '--yes', '--database-port', '6543']), false)

    expect(bundled.databaseUrl).toBe(bundledDatabaseUrl(6543))
    expect(bundled.databasePort).toBe(6543)
  })

  it('resolves the directory against the working directory', async () => {
    const options = await resolveOptions(parseArguments(['nested/crm', '--yes']), false)

    expect(options.directory).toBe(`${process.cwd()}/nested/crm`)
    expect(options.projectName).toBe('crm')
  })
})
