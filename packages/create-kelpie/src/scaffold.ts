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

/** A precondition failed. Reported as a message rather than a stack. */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScaffoldError'
  }
}

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
  ['src/reseal.ts', 'src/reseal.ts'],
  ['web/index.html', 'web/index.html'],
  ['web/main.tsx', 'web/main.tsx'],
  ['vite.config.ts', 'vite.config.ts'],
  ['tsconfig.server.json', 'tsconfig.server.json'],
  ['tsconfig.web.json', 'tsconfig.web.json'],
  ['README.md', 'README.md'],
  ['env', '.env'],
  ['gitignore', '.gitignore'],
])

/** Written only when the project takes the bundled Postgres. */
const DOCKER_TEMPLATE = 'docker-compose.yml'

/** Anything left matching this after substitution is a token nobody filled in. */
const UNRESOLVED_TOKEN = /__[A-Z][A-Z0-9_]*__/

function tokensFor(options: ScaffoldOptions): ReadonlyMap<string, string> {
  return new Map([
    ['__PROJECT_NAME__', options.projectName],
    ['__CORE_VERSION__', options.coreVersion],
    ['__DATABASE_URL__', options.databaseUrl],
    ['__DATABASE_PORT__', String(options.databasePort)],
    ['__EMAIL_FROM__', options.emailFrom],
    ['__PORT__', String(options.port)],
    ['__WEB_PORT__', String(options.webPort)],
    ['__SECRET_ENCRYPTION_KEY__', options.secretEncryptionKey],
  ])
}

function render(template: string, tokens: ReadonlyMap<string, string>, source: string): string {
  let rendered = template

  for (const [token, value] of tokens) {
    rendered = rendered.replaceAll(token, value)
  }

  const leftover = UNRESOLVED_TOKEN.exec(rendered)

  if (leftover !== null) {
    throw new ScaffoldError(`The template ${source} still contains ${leftover[0]} after substitution.`)
  }

  return rendered
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

/** Writes the assembly. Returns the output paths, relative to the directory, in write order. */
export function scaffold(options: ScaffoldOptions): readonly string[] {
  assertWritable(options.directory)

  const tokens = tokensFor(options)
  const files = new Map(TEMPLATE_FILES)

  if (options.docker) {
    files.set(DOCKER_TEMPLATE, DOCKER_TEMPLATE)
  }

  const written: string[] = []

  for (const [source, target] of files) {
    const template = readFileSync(join(templateDirectory, source), 'utf8')
    const destination = join(options.directory, target)

    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, render(template, tokens, source))
    written.push(target)
  }

  return written
}
