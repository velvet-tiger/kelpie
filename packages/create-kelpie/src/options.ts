/**
 * Turns argv and, where it has to, the operator, into `ScaffoldOptions`.
 *
 * Everything non-deterministic lives here: the generated key, the prompts, and
 * reading this package's own version. `scaffold` itself is a pure function of
 * what this produces, which is what makes it testable.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { ScaffoldError } from './scaffold.ts'
import type { ScaffoldOptions } from './scaffold.ts'

const DEFAULT_DIRECTORY = 'kelpie'
const DEFAULT_PORT = 3000
const DEFAULT_WEB_PORT = 5173
const DEFAULT_DATABASE_PORT = 5432
const DEFAULT_EMAIL_FROM = 'kelpie@example.com'

/** The service requires 32 bytes; anything shorter is rejected at boot. */
const SECRET_KEY_BYTES = 32

const HIGHEST_PORT = 65535

export const USAGE = `Scaffold a self-hosted Kelpie assembly.

  npm create kelpie@latest
  npm create kelpie@latest -- [directory] [options]

The -- matters once you pass options: without it npm reads flags like --yes as
its own rather than passing them on.

Options:
  --name <name>            Package name. Defaults to the directory name
  --database-url <url>     postgres:// connection string
  --port <port>            API port (default ${DEFAULT_PORT})
  --web-port <port>        Dev server port (default ${DEFAULT_WEB_PORT})
  --database-port <port>   Host port for the bundled Postgres (default ${DEFAULT_DATABASE_PORT})
  --email-from <address>   Address transactional mail comes from
  --docker, --no-docker    Write a docker-compose.yml for Postgres (default yes)
  --yes                    Take every default; never prompt
  --help                   This message

With --yes and no --database-url, the connection string points at the bundled
Postgres. Without a terminal to prompt on, --yes is required.`

export interface ParsedArguments {
  readonly directory: string | undefined
  readonly name: string | undefined
  readonly databaseUrl: string | undefined
  readonly emailFrom: string | undefined
  readonly port: number
  readonly webPort: number
  readonly databasePort: number
  readonly docker: boolean | undefined
  readonly yes: boolean
  readonly help: boolean
}

function parsePort(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }

  const port = Number(value)

  if (!Number.isInteger(port) || port < 1 || port > HIGHEST_PORT) {
    throw new ScaffoldError(`${name} must be a port number between 1 and ${HIGHEST_PORT}. It is "${value}".`)
  }

  return port
}

/**
 * npm package names are lowercase, and a directory name often is not. Anything
 * that cannot be salvaged falls back rather than failing: the name is cosmetic
 * in a private package.
 */
export function toPackageName(directoryName: string): string {
  const cleaned = directoryName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')

  return cleaned.length > 0 ? cleaned : DEFAULT_DIRECTORY
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      'database-url': { type: 'string' },
      'email-from': { type: 'string' },
      port: { type: 'string' },
      'web-port': { type: 'string' },
      'database-port': { type: 'string' },
      docker: { type: 'boolean' },
      // parseArgs has no native --no-x, so the negation is its own flag.
      'no-docker': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.docker === true && values['no-docker'] === true) {
    throw new ScaffoldError('--docker and --no-docker contradict each other.')
  }

  const docker = values['no-docker'] === true ? false : values.docker === true ? true : undefined

  return {
    directory: positionals[0],
    name: values.name,
    databaseUrl: values['database-url'],
    emailFrom: values['email-from'],
    port: parsePort('--port', values.port, DEFAULT_PORT),
    webPort: parsePort('--web-port', values['web-port'], DEFAULT_WEB_PORT),
    databasePort: parsePort('--database-port', values['database-port'], DEFAULT_DATABASE_PORT),
    docker,
    yes: values.yes === true,
    help: values.help === true,
  }
}

export function generateSecretEncryptionKey(): string {
  return randomBytes(SECRET_KEY_BYTES).toString('base64')
}

export function bundledDatabaseUrl(port: number): string {
  return `postgres://kelpie:kelpie@localhost:${port}/kelpie`
}

/** This package's own version, which is the core version a scaffold pins. */
export function readOwnVersion(): string {
  const manifestUrl = new URL('../package.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'))

  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    throw new ScaffoldError('create-kelpie cannot read its own version.')
  }

  const { version } = parsed as { version: unknown }

  if (typeof version !== 'string') {
    throw new ScaffoldError('create-kelpie has a non-string version in its manifest.')
  }

  return version
}

interface Prompter {
  ask(question: string, fallback: string): Promise<string>
  confirm(question: string, fallback: boolean): Promise<boolean>
  close(): void
}

function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  return {
    async ask(question: string, fallback: string): Promise<string> {
      const answer = (await rl.question(`${question} (${fallback}) `)).trim()

      return answer.length > 0 ? answer : fallback
    },
    async confirm(question: string, fallback: boolean): Promise<boolean> {
      const answer = (await rl.question(`${question} (${fallback ? 'Y/n' : 'y/N'}) `)).trim().toLowerCase()

      if (answer.length === 0) {
        return fallback
      }

      return answer.startsWith('y')
    },
    close(): void {
      rl.close()
    },
  }
}

/**
 * Fills the gaps argv left, asking where there is a terminal to ask on.
 *
 * Without one, `--yes` is required rather than assumed. A scaffolder that
 * silently invents a database URL in CI writes a project that fails at boot,
 * some distance from the cause.
 */
export async function resolveOptions(parsed: ParsedArguments, interactive: boolean): Promise<ScaffoldOptions> {
  if (!interactive && !parsed.yes) {
    throw new ScaffoldError(
      'There is no terminal to prompt on. Pass --yes to take the defaults, and --database-url to point at your database.',
    )
  }

  const prompter = interactive && !parsed.yes ? createPrompter() : undefined

  try {
    const directoryName =
      parsed.directory ?? (await prompter?.ask('Directory', DEFAULT_DIRECTORY)) ?? DEFAULT_DIRECTORY
    const directory = resolve(process.cwd(), directoryName)
    const projectName = parsed.name ?? toPackageName(basename(directory))
    const docker = parsed.docker ?? (await prompter?.confirm('Write a docker-compose.yml for Postgres?', true)) ?? true

    const defaultDatabaseUrl = bundledDatabaseUrl(parsed.databasePort)
    const databaseUrl =
      parsed.databaseUrl ?? (await prompter?.ask('DATABASE_URL', defaultDatabaseUrl)) ?? defaultDatabaseUrl

    const emailFrom =
      parsed.emailFrom ?? (await prompter?.ask('Send mail from', DEFAULT_EMAIL_FROM)) ?? DEFAULT_EMAIL_FROM

    return {
      directory,
      projectName,
      databaseUrl,
      emailFrom,
      port: parsed.port,
      webPort: parsed.webPort,
      databasePort: parsed.databasePort,
      docker,
      secretEncryptionKey: generateSecretEncryptionKey(),
      coreVersion: readOwnVersion(),
    }
  } finally {
    prompter?.close()
  }
}
