import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ScaffoldError, scaffold } from './scaffold.ts'
import type { ScaffoldOptions } from './scaffold.ts'

const scratchDirectories: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'create-kelpie-test-'))

  scratchDirectories.push(directory)

  return join(directory, 'project')
}

function optionsFor(directory: string, overrides: Partial<ScaffoldOptions> = {}): ScaffoldOptions {
  return {
    directory,
    projectName: 'acme-crm',
    databaseUrl: 'postgres://kelpie:kelpie@localhost:5432/kelpie',
    emailFrom: 'crm@acme.example',
    port: 3000,
    webPort: 5173,
    databasePort: 5432,
    docker: true,
    secretEncryptionKey: 'Ge6ZQ0m2rBqL8xW1vN4dT7yUoP3sJhKcAeFiRbXnMlU=',
    coreVersion: '1.2.3',
    ...overrides,
  }
}

/** Every file the scaffold writes, so a walk can assert on content. */
function readAll(directory: string): ReadonlyMap<string, string> {
  const contents = new Map<string, string>()

  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        walk(path, relative)
      } else {
        contents.set(relative, readFileSync(path, 'utf8'))
      }
    }
  }

  walk(directory, '')

  return contents
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('scaffold', () => {
  it('writes the assembly a self-hoster owns', () => {
    const directory = scratch()

    const written = scaffold(optionsFor(directory))

    expect([...written].sort()).toEqual([
      '.env',
      '.gitignore',
      'README.md',
      'docker-compose.yml',
      'kelpie.config.ts',
      'kelpie.ui.config.ts',
      'package.json',
      'src/migrate.ts',
      'src/reseal.ts',
      'src/server.ts',
      'src/worker.ts',
      'tsconfig.server.json',
      'tsconfig.web.json',
      'vite.config.ts',
      'web/index.html',
      'web/main.tsx',
    ])
  })

  it('names the dotfiles correctly, rather than leaving the packed-safe names', () => {
    const directory = scratch()

    scaffold(optionsFor(directory))

    const files = readAll(directory)

    expect(files.has('.gitignore')).toBe(true)
    expect(files.has('.env')).toBe(true)
    expect(files.has('gitignore')).toBe(false)
    expect(files.has('env')).toBe(false)
  })

  it('leaves no token unsubstituted in any file', () => {
    const directory = scratch()

    scaffold(optionsFor(directory))

    for (const [name, content] of readAll(directory)) {
      expect(content, `${name} has an unsubstituted token`).not.toMatch(/__[A-Z][A-Z0-9_]*__/)
    }
  })

  it('pins @kelpie/* at the version it was told to', () => {
    const directory = scratch()

    scaffold(optionsFor(directory, { coreVersion: '2.5.0' }))

    const manifest: { name: string; dependencies: Record<string, string> } = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    )

    expect(manifest.name).toBe('acme-crm')
    expect(manifest.dependencies['@kelpie/server']).toBe('^2.5.0')
    expect(manifest.dependencies['@kelpie/ui']).toBe('^2.5.0')
    // The SMTP sender ships inside @kelpie/server as a built-in core module,
    // so the scaffold no longer pulls a separate package for it.
    expect(manifest.dependencies).not.toHaveProperty('@kelpie/module-smtp-email')
  })

  it('writes the generated key and the database url into .env', () => {
    const directory = scratch()
    const options = optionsFor(directory, { databaseUrl: 'postgres://someone@db.example:6000/crm', docker: false })

    scaffold(options)

    const environment = readFileSync(join(directory, '.env'), 'utf8')

    expect(environment).toContain(`SECRET_ENCRYPTION_KEY=${options.secretEncryptionKey}`)
    expect(environment).toContain('DATABASE_URL=postgres://someone@db.example:6000/crm')
    expect(environment).toContain('PORT=3000')
    expect(environment).toContain('API_PORT=3000')
    expect(environment).toContain('WEB_PORT=5173')
    // Required at boot since 0.5.0: a scaffolded project must carry it or the
    // service it just wrote refuses to start.
    expect(environment).toContain('APP_BASE_URL=http://localhost:5173')
    // Only the bundled Postgres reads it.
    expect(environment).not.toMatch(/^POSTGRES_PASSWORD=/mu)
  })

  // Windows has no owner, group and other bits; Node reports 0o666 for every
  // writable file there, so there is nothing to assert.
  it.skipIf(process.platform === 'win32')('lets only the owner read .env, which holds the key', () => {
    const directory = scratch()

    scaffold(optionsFor(directory))

    expect(statSync(join(directory, '.env')).mode & 0o777).toBe(0o600)
  })

  it('gives every other file the mode a new file gets by default', () => {
    const directory = scratch()

    scaffold(optionsFor(directory))

    // A file this test writes with no mode shows what the umask of this
    // process allows, so the test does not have to change the umask.
    const control = join(directory, 'control.txt')
    writeFileSync(control, '')
    const defaultMode = statSync(control).mode & 0o777

    for (const file of ['README.md', 'package.json', '.gitignore', 'src/server.ts', 'docker-compose.yml']) {
      expect(statSync(join(directory, file)).mode & 0o777, file).toBe(defaultMode)
    }
  })

  it('leaves the email safety settings unset in .env, so the safe defaults apply', () => {
    const directory = scratch()

    scaffold(optionsFor(directory))

    const environment = readFileSync(join(directory, '.env'), 'utf8')

    // Both are in the file as comments only. An active line would permit
    // plain-text SMTP, or put sign-in links in a production log.
    expect(environment).toContain('# SMTP_REQUIRE_TLS=false')
    expect(environment).toContain('# EMAIL_LOG_BODY=true')
    expect(environment).not.toMatch(/^SMTP_REQUIRE_TLS=/mu)
    expect(environment).not.toMatch(/^EMAIL_LOG_BODY=/mu)
  })

  it('omits docker-compose.yml when the project brings its own database', () => {
    const directory = scratch()

    const written = scaffold(optionsFor(directory, { docker: false }))

    expect(written).not.toContain('docker-compose.yml')
    expect(readAll(directory).has('docker-compose.yml')).toBe(false)
  })

  it('publishes the bundled Postgres on the port the connection string names', () => {
    const directory = scratch()

    scaffold(
      optionsFor(directory, { databaseUrl: 'postgres://kelpie:kelpie@localhost:55432/kelpie', databasePort: 55432 }),
    )

    expect(readFileSync(join(directory, 'docker-compose.yml'), 'utf8')).toContain('"127.0.0.1:55432:5432"')
  })

  it('gives the bundled Postgres the user and database name of the connection string', () => {
    const directory = scratch()

    scaffold(optionsFor(directory, { databaseUrl: 'postgres://demo_user:s3cret-pw@localhost:5432/kelpie_demo' }))

    const compose = readFileSync(join(directory, 'docker-compose.yml'), 'utf8')

    expect(compose).toContain('POSTGRES_USER: "demo_user"')
    expect(compose).toContain('POSTGRES_DB: "kelpie_demo"')
    expect(compose).toContain('pg_isready --username demo_user --dbname kelpie_demo')
  })

  it('puts the bundled Postgres password in .env, which only the owner can read, and not in docker-compose.yml', () => {
    const directory = scratch()

    scaffold(optionsFor(directory, { databaseUrl: 'postgres://demo_user:s3cret-pw@localhost:5432/kelpie_demo' }))

    const compose = readFileSync(join(directory, 'docker-compose.yml'), 'utf8')
    const environment = readFileSync(join(directory, '.env'), 'utf8')

    expect(compose).not.toContain('s3cret-pw')
    expect(compose).toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?')
    expect(environment).toMatch(/^POSTGRES_PASSWORD=s3cret-pw$/mu)
  })

  it('quotes the user and database name, so YAML keeps a name like null or 0123 a string', () => {
    const directory = scratch()

    scaffold(optionsFor(directory, { databaseUrl: 'postgres://null:pw@localhost:5432/0123' }))

    const compose = readFileSync(join(directory, 'docker-compose.yml'), 'utf8')

    expect(compose).toContain('POSTGRES_USER: "null"')
    expect(compose).toContain('POSTGRES_DB: "0123"')
  })

  it('writes a password that looks like a template token as it is', () => {
    const directory = scratch()

    scaffold(optionsFor(directory, { databaseUrl: 'postgres://kelpie:__PORT__@localhost:5432/kelpie' }))

    const environment = readFileSync(join(directory, '.env'), 'utf8')

    expect(environment).toMatch(/^POSTGRES_PASSWORD=__PORT__$/mu)
    expect(environment).toContain('DATABASE_URL=postgres://kelpie:__PORT__@localhost:5432/kelpie')
  })

  it.each([
    ['a line break', 'postgres://kelpie:kelpie@localhost:5432/kelpie\nSECRET_ENCRYPTION_KEY=injected'],
    ['a tab', 'postgres://kelpie:kel\tpie@localhost:5432/kelpie'],
    ['a space', 'postgres://kelpie:kelpie@localhost:5432/kelpie '],
  ])('refuses a connection string with %s, with or without the bundled Postgres, and writes nothing', (_name, databaseUrl) => {
    for (const docker of [true, false]) {
      const directory = scratch()

      expect(() => scaffold(optionsFor(directory, { databaseUrl, docker }))).toThrow(/control character/u)
      expect(readdirSync(join(directory, '..'))).toEqual([])
    }
  })

  it('writes nothing when the connection string does not fit the bundled Postgres', () => {
    const directory = scratch()

    expect(() => scaffold(optionsFor(directory, { databaseUrl: 'postgres://kelpie:kelpie@db.example:5432/kelpie' }))).toThrow(
      ScaffoldError,
    )
    expect(readdirSync(join(directory, '..'))).toEqual([])
  })

  it('publishes the bundled Postgres on this machine only', () => {
    const directory = scratch()

    scaffold(optionsFor(directory))

    const published = readFileSync(join(directory, 'docker-compose.yml'), 'utf8')
      .split('\n')
      .filter((line) => line.includes(':5432"'))

    expect(published).toHaveLength(1)
    expect(published[0]).toContain('"127.0.0.1:')
  })

  it('refuses a directory that already holds something', () => {
    const directory = scratch()

    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'README.md'), 'someone else was here')

    expect(() => scaffold(optionsFor(directory))).toThrow(ScaffoldError)
    expect(readFileSync(join(directory, 'README.md'), 'utf8')).toBe('someone else was here')
  })

  it('refuses a directory holding only dotfiles, because a .git is a repository', () => {
    const directory = scratch()

    mkdirSync(join(directory, '.git'), { recursive: true })

    expect(() => scaffold(optionsFor(directory))).toThrow(/not empty/)
  })
})
