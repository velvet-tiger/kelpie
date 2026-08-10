/**
 * Proves that the published packages work when installed somewhere that is not
 * this workspace, by walking the path a self-hoster walks.
 *
 * Inside the workspace they always work, and that proves nothing: npm symlinks
 * `node_modules/@kelpie/server` to `packages/server`, and Node resolves the
 * symlink before it strips types, so the file it loads is never actually under
 * `node_modules`. From a real install it would be, and Node refuses to strip
 * types there (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
 *
 * So: build, pack, scaffold a project with `create-kelpie`, install the tarballs
 * into it, and run it. The scaffolder writes the project rather than this script
 * hand-rolling one, which means the generated manifest's dependency list is
 * under test too. A missing devDependency in the template shows up here as a
 * failed build rather than as a self-hoster's first five minutes.
 *
 * What it catches, in the order the checks run:
 *
 *   1. `@kelpie/server` imports, so the compiled entry point is the one shipped.
 *   2. `coreMigrationsDirectory` points at real migrations. Drizzle reads them
 *      at runtime and they sit outside `dist`, so only `files` puts them in the
 *      tarball.
 *   3. The service boots against Postgres, applies migrations, answers
 *      `/healthz`, and accepts a signup. That is the generated `src/server.ts`,
 *      `kelpie.config.ts`, and `.env` all being right together.
 *   4. A production build of the generated web entry emits the theme utilities.
 *      Tailwind ignores `node_modules` during automatic source detection, so if
 *      the `@source` in `styles.css` does not reach the components beside it,
 *      the build still succeeds and every page ships unstyled.
 *
 * Needs Postgres, through `TEST_DATABASE_URL` in `.env` / `.env.local` or the
 * environment. `make up` writes it. Run the whole thing with
 * `npm run verify:packaging`, and set `KELPIE_KEEP_SCRATCH=1` to keep the
 * scratch directory for inspection.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))

/** The packages under test, in dependency order. */
const PACKAGE_DIRECTORIES = [
  'packages/schemas',
  'packages/server',
  'packages/ui',
  'packages/create-kelpie',
] as const

/**
 * Theme utilities that exist only if Tailwind scanned the Kelpie components. The
 * `@theme` block declares the tokens, but a utility is emitted only where a
 * class naming it appears in scanned source, and the generated project names
 * none of these itself.
 */
const REQUIRED_UTILITIES = ['.bg-surface-raised', '.text-ink-faint', '.bg-sidebar-active'] as const

/** Ports the scaffolded project runs on. High, to stay clear of a running `make dev`. */
const API_PORT = 39117

const WEB_PORT = 39118

const BOOT_TIMEOUT_MS = 60_000

/**
 * Variables the scaffolded `.env` sets, which this process must not pass down.
 *
 * Reading `TEST_DATABASE_URL` loads this repository's `.env` into our own
 * environment, and `--env-file` leaves an inherited variable alone. Without this
 * the child would boot on the repository's `PORT` and `DATABASE_URL` and the
 * generated `.env` would never be read, which is the opposite of what this
 * checks. It cost one `EADDRINUSE` on port 3000 to notice.
 */
const PROJECT_OWNED_VARIABLES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'PORT',
  'API_PORT',
  'WEB_PORT',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'SECRET_ENCRYPTION_KEY',
  'SECRET_ENCRYPTION_KEY_PREVIOUS',
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
] as const

/** A step of the check failed. Reported as a message rather than a stack. */
class PackagingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackagingError'
  }
}

interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly overrides?: Readonly<Record<string, string>>
}

function report(message: string): void {
  process.stdout.write(`${message}\n`)
}

function readManifest(directory: string): PackageManifest {
  const path = join(directory, 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))

  if (typeof parsed !== 'object' || parsed === null) {
    throw new PackagingError(`${path} does not contain a JSON object.`)
  }

  const manifest = parsed as PackageManifest

  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new PackagingError(`${path} is missing "name" or "version".`)
  }

  return manifest
}

function run(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, [...args], { cwd, stdio: 'inherit' })
}

/**
 * The database the scaffolded service boots against.
 *
 * `.env.local` first, because `loadEnvFile` keeps the first value it sees and
 * `make up` writes the live port there. A variable already in the environment
 * beats both, which is what lets CI point this at its own database.
 */
function testDatabaseUrl(): string {
  for (const file of ['.env.local', '.env']) {
    const path = join(repositoryRoot, file)

    if (existsSync(path)) {
      process.loadEnvFile(path)
    }
  }

  const url = process.env.TEST_DATABASE_URL

  if (url === undefined || url.length === 0) {
    throw new PackagingError(
      'TEST_DATABASE_URL is not set. This check boots the scaffolded service, so it needs Postgres. Run `make up`.',
    )
  }

  return url
}

/** Builds each package and packs it, returning the tarball path per package name. */
function packPackages(destination: string): ReadonlyMap<string, string> {
  const tarballs = new Map<string, string>()

  for (const directory of PACKAGE_DIRECTORIES) {
    const absolute = join(repositoryRoot, directory)
    const manifest = readManifest(absolute)

    report(`building ${manifest.name}`)
    run('npm', ['run', 'build', '--workspace', directory], repositoryRoot)

    report(`packing ${manifest.name}`)
    run('npm', ['pack', '--pack-destination', destination], absolute)

    // npm derives the filename from the manifest: scope separator dropped, then
    // name-version.tgz.
    const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
    const tarball = join(destination, filename)

    if (!existsSync(tarball)) {
      throw new PackagingError(`npm pack did not produce ${tarball}. Its output above says what it wrote instead.`)
    }

    tarballs.set(manifest.name, tarball)
  }

  return tarballs
}

/**
 * Runs the scaffolder exactly as `npm create kelpie` would, from its built
 * output rather than its source, because that is what ships.
 */
function scaffoldProject(parent: string, name: string, databaseUrl: string): string {
  const cli = join(repositoryRoot, 'packages/create-kelpie/dist/index.js')

  if (!existsSync(cli)) {
    throw new PackagingError(`create-kelpie has no built entry point at ${cli}.`)
  }

  run(
    'node',
    [
      cli,
      name,
      '--yes',
      '--no-docker',
      '--database-url',
      databaseUrl,
      '--port',
      String(API_PORT),
      '--web-port',
      String(WEB_PORT),
    ],
    parent,
  )

  return join(parent, name)
}

/**
 * Points the generated manifest's `@kelpie/*` dependencies at the tarballs.
 *
 * A published scaffold resolves these from the registry. Here the whole point is
 * to test what is about to be published, which is not there yet. `overrides`
 * covers the transitive `@kelpie/schemas` that server and ui both declare.
 */
function pointAtLocalTarballs(project: string, tarballs: ReadonlyMap<string, string>): void {
  const path = join(project, 'package.json')
  const manifest: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'))
  const dependencies = manifest.dependencies

  if (typeof dependencies !== 'object' || dependencies === null) {
    throw new PackagingError('The scaffolded manifest has no dependencies.')
  }

  const overrides: Record<string, string> = {}

  for (const [name, tarball] of tarballs) {
    if (!name.startsWith('@kelpie/')) {
      continue
    }

    overrides[name] = `file:${tarball}`

    if (name in dependencies) {
      ;(dependencies as Record<string, string>)[name] = `file:${tarball}`
    }
  }

  const expected = ['@kelpie/server', '@kelpie/ui']
  const missing = expected.filter((name) => !(name in dependencies))

  if (missing.length > 0) {
    throw new PackagingError(`The scaffolded manifest does not depend on ${missing.join(' or ')}.`)
  }

  manifest.overrides = overrides

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Asserts the shipped entry point loads and its migrations came with it. */
function writeServerCheck(project: string): void {
  writeFileSync(
    join(project, 'check-server.js'),
    `import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { coreMigrationsDirectory, coreModules, createApp, loadConfig } from '@kelpie/server'
import { createTestApp } from '@kelpie/server/testing'

for (const [name, value] of Object.entries({ createApp, loadConfig, createTestApp })) {
  if (typeof value !== 'function') {
    throw new Error(\`@kelpie/server exported \${name} as \${typeof value}, expected a function.\`)
  }
}

if (coreModules.length === 0) {
  throw new Error('@kelpie/server exported an empty coreModules list.')
}

const journal = join(coreMigrationsDirectory, 'meta', '_journal.json')

if (!existsSync(journal)) {
  throw new Error(
    \`coreMigrationsDirectory is \${coreMigrationsDirectory}, which has no meta/_journal.json. \` +
      'The migrations directory is outside dist, so the "files" field has to ship it.',
  )
}

const migrations = readdirSync(coreMigrationsDirectory).filter((entry) => entry.endsWith('.sql'))

if (migrations.length === 0) {
  throw new Error(\`No .sql migrations under \${coreMigrationsDirectory}.\`)
}

process.stdout.write(\`  server imports, \${coreModules.length} core modules, \${migrations.length} migrations\\n\`)
`,
  )
}

async function fetchOrUndefined(url: string, init?: RequestInit): Promise<Response | undefined> {
  try {
    return await fetch(url, init)
  } catch {
    return undefined
  }
}

/**
 * Boots the generated service and exercises it.
 *
 * This is the check that covers the template as a whole: `src/server.ts`
 * wiring, the module list, and every variable the scaffolder wrote into `.env`.
 * A signup touches config, the database, migrations, password hashing, and the
 * transaction scope in one request.
 */
async function bootAndSignUp(project: string): Promise<void> {
  const environment: Record<string, string | undefined> = { ...process.env }

  for (const name of PROJECT_OWNED_VARIABLES) {
    delete environment[name]
  }

  // `npm run dev`, not `npm start`, so the Vite config and its proxy are under
  // test too, and every address below is the one the generated README hands out.
  // `detached` puts the two children in their own process group: concurrently
  // spawns them, so killing npm alone leaves an API holding the port.
  const service = spawn('npm', ['run', 'dev'], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
    detached: true,
  })
  const output: string[] = []

  service.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  service.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))

  const origin = `http://localhost:${WEB_PORT}`

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let health: Response | undefined

    while (Date.now() < deadline) {
      if (service.exitCode !== null) {
        throw new PackagingError(`The scaffolded service exited with ${service.exitCode}.\n${output.join('')}`)
      }

      const answer = await fetchOrUndefined(`${origin}/healthz`)

      // The dev server answers before the API does, and proxies a failed
      // upstream as a 502. Waiting for a 200 waits for both.
      if (answer !== undefined && answer.status === 200) {
        health = answer
        break
      }

      await delay(500)
    }

    if (health === undefined) {
      throw new PackagingError(
        `Nothing answered 200 on ${origin}/healthz within ${BOOT_TIMEOUT_MS / 1000}s. That is the dev server on ` +
          `WEB_PORT proxying /healthz to the API on API_PORT, so either did not come up on the port .env names.\n` +
          output.join(''),
      )
    }

    const body: unknown = await health.json()

    report(`  dev server on ${WEB_PORT} proxies /healthz to the API: ${JSON.stringify(body)}`)

    const page = await fetchOrUndefined(`${origin}/signup`)

    if (page === undefined || page.status !== 200) {
      throw new PackagingError(`GET /signup returned ${page?.status ?? 'nothing'}.\n${output.join('')}`)
    }

    const html = await page.text()

    for (const fragment of ['<div id="root">', 'main.tsx']) {
      if (!html.includes(fragment)) {
        throw new PackagingError(`GET /signup returned HTML without ${fragment}:\n${html.slice(0, 500)}`)
      }
    }

    report('  /signup serves the app shell')

    // A unique address per run, so a second run against the same database does
    // not collide with the first one's account.
    const email = `packaging-${process.pid}-${API_PORT}@example.com`
    const signup = await fetchOrUndefined(`${origin}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'Packaging Check', password: 'a properly long password' }),
    })

    if (signup === undefined) {
      throw new PackagingError(`POST /v1/auth/signup did not answer.\n${output.join('')}`)
    }

    if (signup.status < 200 || signup.status >= 300) {
      throw new PackagingError(`POST /v1/auth/signup returned ${signup.status}: ${await signup.text()}`)
    }

    report(`  signup succeeds through the proxy, ${signup.status}`)
  } finally {
    // Negative pid: the whole group, so concurrently's two children go too.
    const group = service.pid

    if (group === undefined) {
      service.kill('SIGTERM')
    } else {
      try {
        process.kill(-group, 'SIGTERM')
      } catch {
        // Already gone, which is the outcome we wanted.
      }
    }
  }
}

function assertThemeUtilitiesEmitted(project: string): void {
  const assets = join(project, 'dist', 'assets')

  if (!existsSync(assets)) {
    throw new PackagingError(`The scaffolded build produced no ${assets}.`)
  }

  const stylesheets = readdirSync(assets).filter((entry) => entry.endsWith('.css'))

  if (stylesheets.length === 0) {
    throw new PackagingError(`The scaffolded build emitted no CSS into ${assets}.`)
  }

  const css = stylesheets.map((entry) => readFileSync(join(assets, entry), 'utf8')).join('\n')
  const missing = REQUIRED_UTILITIES.filter((utility) => !css.includes(utility))

  if (missing.length > 0) {
    throw new PackagingError(
      `The scaffolded build emitted CSS without ${missing.join(', ')}. Tailwind did not scan the ` +
        'components in @kelpie/ui. It ignores node_modules during automatic source detection, so ' +
        'the @source in styles.css has to reach them and the "files" field has to ship them.',
    )
  }

  report(`  web bundle builds, ${REQUIRED_UTILITIES.length} theme utilities present in the CSS`)
}

async function main(): Promise<void> {
  const databaseUrl = testDatabaseUrl()
  const scratch = mkdtempSync(join(tmpdir(), 'kelpie-packaging-'))
  const tarballDirectory = join(scratch, 'tarballs')

  mkdirSync(tarballDirectory)

  try {
    const tarballs = packPackages(tarballDirectory)

    report('\nscaffolding a project with create-kelpie')

    const project = scaffoldProject(scratch, 'app', databaseUrl)

    pointAtLocalTarballs(project, tarballs)
    writeServerCheck(project)

    report(`\ninstalling into ${project}`)
    run('npm', ['install', '--no-audit', '--no-fund'], project)

    report('\nchecking @kelpie/server')
    run('node', ['check-server.js'], project)

    report('\nbooting the scaffolded service')
    await bootAndSignUp(project)

    report('\nbuilding the scaffolded web bundle')
    run('npm', ['run', 'build'], project)
    assertThemeUtilitiesEmitted(project)

    report('\npackaging verified: create-kelpie writes a project that installs, boots, and builds')
  } finally {
    if (process.env.KELPIE_KEEP_SCRATCH === undefined) {
      rmSync(scratch, { recursive: true, force: true })
    } else {
      report(`scratch directory kept at ${scratch}`)
    }
  }
}

try {
  await main()
} catch (error: unknown) {
  if (error instanceof PackagingError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }

  throw error
}
