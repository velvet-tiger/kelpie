/**
 * The bundled Postgres in `docker-compose.yml` must match `DATABASE_URL`, or
 * the service fails at boot against a database the container never made.
 * This reads the user, password and database name from the URL, and refuses
 * a URL the bundled Postgres cannot serve. The refusal comes at scaffold
 * time, next to the flag that caused it.
 */

import { ScaffoldError } from './errors.ts'

export interface BundledDatabase {
  readonly user: string
  /** Goes into `.env`, never into `docker-compose.yml`: only `.env` is owner-only. */
  readonly password: string
  readonly name: string
}

/** Postgres listens on this port when the URL names none. */
const POSTGRES_DEFAULT_PORT = 5432

/**
 * `docker-compose.yml` publishes the port on 127.0.0.1 only, so a URL must
 * reach it through one of these names.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

/**
 * The user and the database name go into a `CMD-SHELL` healthcheck without
 * quotes, and into YAML in double quotes. This set is safe in both. The YAML
 * quotes keep a name like `null` or `0123` a string.
 */
const IDENTIFIER = /^[A-Za-z0-9_]+$/

/**
 * The password goes into `.env` without quotes. Node's `--env-file` and
 * Docker Compose both read `.env`, and Compose expands `$` in it. The URL
 * unreserved characters mean the same thing to both.
 */
const PASSWORD = /^[A-Za-z0-9._~-]+$/

/**
 * Reads what the bundled Postgres needs from `databaseUrl`, or throws a
 * `ScaffoldError` that names the conflict. `databasePort` is the host port
 * `docker-compose.yml` publishes.
 */
export function bundledDatabaseFor(databaseUrl: string, databasePort: number): BundledDatabase {
  const url = parseUrl(databaseUrl)
  const fix = 'Change --database-url, or pass --no-docker to use a database you run yourself.'

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ScaffoldError(`--database-url must start with postgres:// or postgresql://. ${fix}`)
  }

  // The host of a `postgres:` URL keeps its case: the scheme is not one the
  // URL parser knows.
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ScaffoldError(
      `--database-url points at ${url.hostname}, but the bundled Postgres listens on 127.0.0.1 only. ` +
        `Use localhost or 127.0.0.1. ${fix}`,
    )
  }

  const urlPort = url.port === '' ? POSTGRES_DEFAULT_PORT : Number(url.port)

  if (urlPort !== databasePort) {
    throw new ScaffoldError(
      `--database-url uses port ${urlPort}, but the bundled Postgres is published on port ${databasePort}. ` +
        `Pass --database-port ${urlPort}, or change the port in --database-url.`,
    )
  }

  const user = decode(url.username, 'user')
  const password = decode(url.password, 'password')
  const name = decode(url.pathname.replace(/^\//u, ''), 'database name')

  checkPart(user, IDENTIFIER, 'user', 'letters, digits and _', fix)
  checkPart(name, IDENTIFIER, 'database name', 'letters, digits and _', fix)
  checkPart(password, PASSWORD, 'password', 'letters, digits and . _ ~ -', fix)

  return { user, password, name }
}

function parseUrl(databaseUrl: string): URL {
  try {
    return new URL(databaseUrl)
  } catch (error) {
    if (error instanceof TypeError) {
      // The message would repeat the URL, and the URL holds the password.
      throw new ScaffoldError('--database-url is not a valid URL.')
    }

    throw error
  }
}

function decode(part: string, label: string): string {
  try {
    return decodeURIComponent(part)
  } catch (error) {
    if (error instanceof URIError) {
      throw new ScaffoldError(`The ${label} in --database-url has a broken percent-encoding.`)
    }

    throw error
  }
}

/** The message names the part, never its value: the value may be the password. */
function checkPart(value: string, pattern: RegExp, label: string, allowed: string, fix: string): void {
  if (value === '') {
    throw new ScaffoldError(`--database-url has no ${label}. The bundled Postgres needs one. ${fix}`)
  }

  if (!pattern.test(value)) {
    throw new ScaffoldError(
      `The ${label} in --database-url may use only ${allowed} with the bundled Postgres. ${fix}`,
    )
  }
}
