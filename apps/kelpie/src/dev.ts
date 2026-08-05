import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { NoFreePortError, findFreePort } from './devPorts.ts'

/**
 * The development launcher.
 *
 * `npm run dev` used to hand both processes a fixed port and let whichever one
 * lost the race die on `EADDRINUSE`. This picks free ports first and tells each
 * process which one it has, so a second checkout, a stale process, or anything
 * else already on 3000 no longer stops a working tree from running.
 *
 * The service is untouched by this. It binds the `PORT` it is given and fails
 * when that port is taken, in development and in production alike. Only the
 * choice of number moved, and only here.
 */

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const environmentFile = fileURLToPath(new URL('../../../.env', import.meta.url))
const localEnvironmentFile = fileURLToPath(new URL('../../../.env.local', import.meta.url))

/** Vite's own default, and the address the README tells people to open. */
const DEFAULT_WEB_PORT = 5173

const HIGHEST_PORT = 65535

/** A problem with the local setup, reported as a message rather than a stack. */
class DevStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevStartError'
  }
}

function report(message: string): void {
  process.stdout.write(`${message}\n`)
}

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

function parsePort(name: string, value: string): number {
  const port = Number(value)

  if (!Number.isInteger(port) || port < 1 || port > HIGHEST_PORT) {
    throw new DevStartError(`${name} must be a port number between 1 and ${HIGHEST_PORT}. It is "${value}".`)
  }

  return port
}

function preferredApiPort(): number {
  const configured = process.env.PORT

  if (configured === undefined || configured.length === 0) {
    throw new DevStartError('PORT is not set. Copy .env.example to .env at the repository root.')
  }

  return parsePort('PORT', configured)
}

function preferredWebPort(): number {
  const configured = process.env.WEB_PORT

  return configured === undefined || configured.length === 0 ? DEFAULT_WEB_PORT : parsePort('WEB_PORT', configured)
}

function reportAssignment(name: string, port: number, preferred: number): void {
  const moved = port === preferred ? '' : ` (${preferred} was in use)`

  report(`${name}  http://localhost:${port}${moved}`)
}

async function main(): Promise<void> {
  // The API child reads these itself. The launcher reads them too, because the
  // preferred ports live there and the scan has to start somewhere.
  //
  // `.env.local` first, and that ordering is load-bearing in two ways.
  // `loadEnvFile` keeps the first value it sees, so reading it first is what
  // makes it win. And whatever the launcher ends up holding is inherited by the
  // child, where an inherited variable beats `--env-file` — so loading `.env`
  // first here would pin the child to the stale database port no matter what
  // its own `--env-file-if-exists` flag says.
  if (existsSync(localEnvironmentFile)) {
    process.loadEnvFile(localEnvironmentFile)
  }

  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile)
  }

  const apiPreference = preferredApiPort()
  const webPreference = preferredWebPort()

  // Each probe binds what its process binds. `@hono/node-server` is given no
  // hostname and takes every interface; Vite's default host is localhost.
  const apiPort = await findFreePort({ preferredPort: apiPreference, hostname: undefined, taken: [] })
  const webPort = await findFreePort({ preferredPort: webPreference, hostname: 'localhost', taken: [apiPort] })

  reportAssignment('api', apiPort, apiPreference)
  reportAssignment('web', webPort, webPreference)

  // These beat `.env`, because `--env-file` leaves an inherited variable alone.
  // `API_PORT` carries the same number under a second name, for the Vite proxy;
  // see the comment in `vite.config.ts` for why it cannot read `PORT`.
  const child = spawn('npm', ['run', 'dev:processes'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(apiPort),
      API_PORT: String(apiPort),
      WEB_PORT: String(webPort),
    },
  })

  child.on('error', (error: Error) => {
    reportFatal(`Could not start the dev processes: ${error.message}`)
    process.exit(1)
  })

  child.on('exit', (code: number | null) => {
    process.exit(code ?? 1)
  })
}

try {
  await main()
} catch (error: unknown) {
  if (error instanceof DevStartError || error instanceof NoFreePortError) {
    reportFatal(error.message)
    process.exit(1)
  }

  throw error
}
