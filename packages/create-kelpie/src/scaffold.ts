/**
 * Writes a Kelpie assembly into a directory.
 *
 * Everything here is deterministic: the caller supplies the generated secret and
 * every other value, so a test can assert on exact output. `resolveOptions` in
 * `options.ts` is where the non-deterministic parts live.
 */

import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BundledDatabase } from './bundledDatabase.ts'
import { bundledDatabaseFor } from './bundledDatabase.ts'
import { ScaffoldError } from './errors.ts'

/** Resolves the same from `src/` and from `dist/`; both sit one level down. */
const templateDirectory = fileURLToPath(new URL('../templates/', import.meta.url))

export interface ScaffoldOptions {
  /** Absolute path of the directory to write into. Created if missing. */
  readonly directory: string
  readonly projectName: string
  readonly databaseUrl: string
  readonly emailFrom: string
  readonly port: number
  readonly webPort: number
  /** The host port `docker-compose.yml` publishes Postgres on. Ignored without `docker`. */
  readonly databasePort: number
  readonly docker: boolean
  /** 32 bytes of base64. Generated per project by `resolveOptions`. */
  readonly secretEncryptionKey: string
  /** The `@kelpie/*` version range the generated manifest asks for. */
  readonly coreVersion: string
}

export { ScaffoldError }

/**
 * The output file that holds secrets: `SECRET_ENCRYPTION_KEY` and the
 * database URL with its password.
 */
const ENVIRONMENT_FILE = '.env'

/**
 * Read and write for the owner only. Without it the file gets the default
 * mode, which on most machines lets every user of the machine read it.
 * Windows ignores the mode: access there comes from the directory's ACL.
 */
const OWNER_ONLY_MODE = 0o600

/** What Node gives a new file when no mode is named. The umask then removes bits. */
const DEFAULT_MODE = 0o666

/**
 * Template path to output path.
 *
 * `env` and `gitignore` are renamed rather than stored under their real names
 * because npm silently drops a file called `.gitignore` from a published
 * tarball, and a stray `.env` in the package directory is a trap regardless.
 */
const TEMPLATE_FILES: ReadonlyMap<string, string> = new Map([
  ['package.json', 'package.json'],
  ['kelpie.config.ts', 'kelpie.config.ts'],
  ['kelpie.ui.config.ts', 'kelpie.ui.config.ts'],
  ['src/server.ts', 'src/server.ts'],
  ['src/migrate.ts', 'src/migrate.ts'],
  ['src/worker.ts', 'src/worker.ts'],
  ['src/reseal.ts', 'src/reseal.ts'],
  ['web/index.html', 'web/index.html'],
  ['web/main.tsx', 'web/main.tsx'],
  ['vite.config.ts', 'vite.config.ts'],
  ['tsconfig.server.json', 'tsconfig.server.json'],
  ['tsconfig.web.json', 'tsconfig.web.json'],
  ['README.md', 'README.md'],
  ['env', ENVIRONMENT_FILE],
  ['gitignore', '.gitignore'],
])

/** Written only when the project takes the bundled Postgres. */
const DOCKER_TEMPLATE = 'docker-compose.yml'

/** A token in a template. Each one must have a value in `tokensFor`. */
const TOKEN = /__[A-Z][A-Z0-9_]*__/gu

/**
 * The `.env` lines for the bundled Postgres, or nothing without it. Docker
 * Compose reads `POSTGRES_PASSWORD` from `.env` for `docker-compose.yml`.
 */
function bundledDatabaseEnvironment(database: BundledDatabase | undefined): string {
  if (database === undefined) {
    return ''
  }

  return (
    '\n# Read by Docker Compose for the bundled Postgres in docker-compose.yml. It\n' +
    '# must match the password in DATABASE_URL.\n' +
    `POSTGRES_PASSWORD=${database.password}\n`
  )
}

function tokensFor(options: ScaffoldOptions, database: BundledDatabase | undefined): ReadonlyMap<string, string> {
  return new Map([
    ['__PROJECT_NAME__', options.projectName],
    ['__CORE_VERSION__', options.coreVersion],
    ['__DATABASE_URL__', options.databaseUrl],
    ['__DATABASE_PORT__', String(options.databasePort)],
    ['__EMAIL_FROM__', options.emailFrom],
    ['__PORT__', String(options.port)],
    ['__WEB_PORT__', String(options.webPort)],
    ['__SECRET_ENCRYPTION_KEY__', options.secretEncryptionKey],
    ['__BUNDLED_DATABASE_ENV__', bundledDatabaseEnvironment(database)],
    // Empty without the bundled Postgres: docker-compose.yml is not written then.
    ['__POSTGRES_USER__', database?.user ?? ''],
    ['__POSTGRES_DB__', database?.name ?? ''],
  ])
}

/**
 * One pass over the template, so a value is never scanned again: a password
 * that looks like `__PORT__` stays as it is, and is never named in an error.
 */
function render(template: string, tokens: ReadonlyMap<string, string>, source: string): string {
  return template.replace(TOKEN, (token) => {
    const value = tokens.get(token)

    if (value === undefined) {
      throw new ScaffoldError(`The template ${source} contains ${token}, which nothing fills in.`)
    }

    return value
  })
}

/**
 * Refuses a directory that already holds anything, so a mistyped path cannot
 * overwrite a project. Dotfiles count; a directory with a `.git` in it is
 * someone's repository.
 */
export function assertWritable(directory: string): void {
  if (!existsSync(directory)) {
    return
  }

  const entries = readdirSync(directory)

  if (entries.length > 0) {
    throw new ScaffoldError(
      `${directory} is not empty. It holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ` +
        'including ' +
        entries
          .slice(0, 3)
          .map((entry) => `"${entry}"`)
          .join(', ') +
        '. Pick an empty directory, or a path that does not exist yet.',
    )
  }
}

/**
 * `DATABASE_URL` goes into `.env` as it was typed. A newline in it would add
 * a line of its own to `.env`, and the URL parser drops tabs and newlines, so
 * a parsed URL would not show it. The message does not repeat the URL: it may
 * hold the password.
 */
export function assertSingleLine(databaseUrl: string): void {
  if (/[\s\p{Cc}]/u.test(databaseUrl)) {
    throw new ScaffoldError('--database-url contains a space, a tab, a line break or another control character.')
  }
}

/** Writes the assembly. Returns the output paths, relative to the directory, in write order. */
export function scaffold(options: ScaffoldOptions): readonly string[] {
  assertWritable(options.directory)
  assertSingleLine(options.databaseUrl)

  // Checked before anything is written, so a refused URL leaves no files.
  const database = options.docker ? bundledDatabaseFor(options.databaseUrl, options.databasePort) : undefined
  const tokens = tokensFor(options, database)
  const files = new Map(TEMPLATE_FILES)

  if (options.docker) {
    files.set(DOCKER_TEMPLATE, DOCKER_TEMPLATE)
  }

  // Every file is rendered before the first write, so a template that fails
  // leaves no half-written project behind.
  const rendered = [...files].map(([source, target]) => ({
    target,
    content: render(readFileSync(join(templateDirectory, source), 'utf8'), tokens, source),
  }))

  for (const { target, content } of rendered) {
    const destination = join(options.directory, target)

    mkdirSync(dirname(destination), { recursive: true })
    // The mode applies because the file is new: `assertWritable` refused a
    // directory that held anything.
    writeFileSync(destination, content, {
      mode: target === ENVIRONMENT_FILE ? OWNER_ONLY_MODE : DEFAULT_MODE,
    })
  }

  return rendered.map(({ target }) => target)
}
