import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
      'src/reseal.ts',
      'src/server.ts',
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
    expect(manifest.dependencies['@kelpie/module-smtp-email']).toBe('^2.5.0')
  })

  it('writes the generated key and the database url into .env', () => {
    const directory = scratch()
    const options = optionsFor(directory, { databaseUrl: 'postgres://someone@db.example:6000/crm' })

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
  })

  it('omits docker-compose.yml when the project brings its own database', () => {
    const directory = scratch()

    const written = scaffold(optionsFor(directory, { docker: false }))

    expect(written).not.toContain('docker-compose.yml')
    expect(readAll(directory).has('docker-compose.yml')).toBe(false)
  })

  it('publishes the bundled Postgres on the port the connection string names', () => {
    const directory = scratch()

    scaffold(optionsFor(directory, { databasePort: 55432 }))

    expect(readFileSync(join(directory, 'docker-compose.yml'), 'utf8')).toContain('"55432:5432"')
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
