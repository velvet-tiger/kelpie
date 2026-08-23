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
 *   3. The generated project passes its own `npm run typecheck`. Its tsconfig is
 *      stricter than this repository's, so `apps/kelpie` compiling proves
 *      nothing about what the scaffolder writes.
 *   4. The service boots against Postgres, applies migrations, answers
 *      `/healthz`, and accepts a signup. That is the generated `src/server.ts`,
 *      `kelpie.config.ts`, and `.env` all being right together.
 *   5. `npm run migrate` applies pending migrations as its own process and exits
 *      clean. Boot already migrated in check 4, so this proves the standalone
 *      release-step command resolves its tarball imports and reaches the
 *      database, the way a multi-instance deploy runs it once before starting
 *      the instances with `--no-migrate`.
 *   6. `npm run reseal` runs against the generated `.env` and exits clean. The
 *      README documents this as the key-rotation command; nothing else here
 *      calls it, so a missing script or a broken import would otherwise
 *      surface only when a self-hoster rotates their key for the first time.
 *   7. A production build of the generated web entry emits the theme utilities,
 *      with `.env` moved aside. Tailwind ignores `node_modules` during automatic
 *      source detection, so if the `@source` in `styles.css` does not reach the
 *      components beside it, the build still succeeds and every page ships
 *      unstyled. The missing `.env` is the container case: a build that reads
 *      the environment works here and fails in an image.
 *   8. The API serves that build on its own, with `WEB_BUNDLE_DIR` set and no
 *      dev server in front of it. Checks 4 and 7 both pass while a deployment
 *      shows a blank page, because one runs Vite and the other never serves what
 *      it built.
 *
 * Needs Postgres, through `TEST_DATABASE_URL` in `.env` / `.env.local` or the
 * environment. `make up` writes it. Run the whole thing with
 * `npm run verify:packaging`, and set `KELPIE_KEEP_SCRATCH=1` to keep the
 * scratch directory for inspection.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  'EMAIL_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
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

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: Record<string, string | undefined>,
): void {
  execFileSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    ...(environment === undefined ? {} : { env: environment }),
  })
}

/**
 * This process's environment, minus everything the generated project owns.
 *
 * Reading `TEST_DATABASE_URL` loads this repository's `.env` into our own
 * environment, so without this a child inherits our `PORT`, `DATABASE_URL` and
 * `API_PORT` and never reads the generated `.env` at all. Every step that
 * exercises the generated project has to start from this rather than from
 * `process.env`.
 */
function projectEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env }

  for (const name of PROJECT_OWNED_VARIABLES) {
    delete environment[name]
  }

  return environment
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

  // The SMTP sender ships inside @kelpie/server as a built-in core module.
  // A scaffold that pulled it as a separate package would install a version
  // never published, so this asserts the dependency is not there.
  if ('@kelpie/module-smtp-email' in dependencies) {
    throw new PackagingError(
      'The scaffolded manifest depends on @kelpie/module-smtp-email. That package is not published; ' +
        'the SMTP sender is now a built-in core module inside @kelpie/server.',
    )
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

const smtpModule = coreModules.find((entry) => entry.id === 'smtp-email')

if (smtpModule === undefined) {
  throw new Error(
    '@kelpie/server\\u0027s coreModules does not include the built-in smtp-email module. ' +
      'A scaffolded project relies on it for EMAIL_PROVIDER=smtp and pulls no separate package for it.',
  )
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
  const environment = projectEnvironment()

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
    // Exactly the fields the signup schema accepts: unknown fields answer 422
    // (api.md), and this script has now missed two signup contract changes in
    // a row. The verification link is built server-side from APP_BASE_URL.
    const signup = await fetchOrUndefined(`${origin}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        name: 'Packaging Check',
        password: 'a properly long password',
      }),
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

/**
 * Runs the generated project's own `migrate` command.
 *
 * Boot already applied the migrations in the check before this one, so this is
 * a clean no-op. That is the point: it proves the standalone release-step
 * command resolves its `@kelpie/server` imports from the installed tarball,
 * reads the scaffolded `.env`, reaches the database, and exits clean, the way a
 * multi-instance deploy runs it before starting instances with `--no-migrate`.
 * Nothing else here exercises `npm run migrate`, so a missing script or a
 * broken import would otherwise surface only in a self-hoster's release step.
 */
function migrateAssembly(project: string): void {
  run('npm', ['run', 'migrate'], project, projectEnvironment())
  report('  the scaffolded migrate command runs against the generated .env')
}

/**
 * Runs the generated project's own `reseal` script.
 *
 * Proves the documented key-rotation command actually works: the script
 * resolves its `@kelpie/server` imports from the installed tarball, reads the
 * scaffolded `.env`, and reaches the database. Nothing else in this file
 * exercises `npm run reseal`, so a missing script or a broken import here
 * would otherwise surface only when a self-hoster rotates their key for the
 * first time.
 */
function resealAssembly(project: string): void {
  run('npm', ['run', 'reseal'], project, projectEnvironment())
  report('  the scaffolded reseal script runs against the generated .env')
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

/**
 * Runs the generated project's own `typecheck` script.
 *
 * The templates are stricter than this repository: `tsconfig.base.json` leaves
 * `exactOptionalPropertyTypes` off and `templates/tsconfig.server.json` turns it
 * on, so `apps/kelpie` can compile code a scaffolded project rejects. Nothing
 * here ran that script, and a generated project shipped for two releases unable
 * to typecheck itself.
 */
function typecheckProject(project: string): void {
  run('npm', ['run', 'typecheck'], project)
  report('  the generated project typechecks against its own tsconfig')
}

/**
 * Builds the web bundle with `.env` moved out of the way.
 *
 * A production build emits static files and talks to nothing, so it must not
 * need the environment. Building beside a `.env` is what hid a `vite.config.ts`
 * that demanded `API_PORT` on every invocation: the check passed here and the
 * same build failed in a container, which deliberately excludes `.env` because
 * it holds `SECRET_ENCRYPTION_KEY`.
 *
 * Moving the file is not enough on its own. `loadEnv` reads matching variables
 * out of `process.env` too, and this repository's own `.env` is loaded into ours
 * by the time we get here, so an inherited `API_PORT` stood in for the file and
 * the first version of this check passed against the unfixed template.
 *
 * Scrubbing the environment also fixed something quieter. Our `.env` sets
 * `NODE_ENV=development`, Vite leaves an existing `NODE_ENV` alone, and the
 * build inherited it. Every run of this check until now built a development
 * bundle: 1,108 kB against the 873 kB a self-hoster actually ships. The
 * assertions below were made about an artifact nobody deploys.
 *
 * Restored in a `finally`, because `serveBuiltBundle` below still needs it.
 */
function buildWithoutEnvironmentFile(project: string): void {
  const envFile = join(project, '.env')
  const stashed = join(project, '.env.stashed-by-packaging-check')

  renameSync(envFile, stashed)

  try {
    run('npm', ['run', 'build'], project, projectEnvironment())
  } finally {
    renameSync(stashed, envFile)
  }

  report('  the web bundle builds with no .env beside it and none of its variables set')
}

/** A hashed asset the build emitted, to prove the file server reaches real files. */
function firstBuiltScript(project: string): string {
  const assets = join(project, 'dist', 'assets')
  const script = readdirSync(assets).find((entry) => entry.endsWith('.js'))

  if (script === undefined) {
    throw new PackagingError(`The scaffolded build emitted no JavaScript into ${assets}.`)
  }

  return `/assets/${script}`
}

/**
 * Serves the built bundle from the API alone, the way a deployment does.
 *
 * `bootAndSignUp` above runs `npm run dev`, where Vite serves the pages and
 * proxies the API. That hides whether anything serves them without Vite, which
 * for a long time nothing did: `createApp` answers `/v1`, `/mcp` and `/healthz`,
 * so a deployed assembly returned a blank page to every browser. The dev proxy
 * was the only path ever exercised, which is exactly why this check is here and
 * not left to the one above.
 *
 * `npm start` rather than `npm run dev`: no Vite, no proxy, one process on
 * `API_PORT`, which is the shape a Dockerfile runs.
 */
async function serveBuiltBundle(project: string): Promise<void> {
  const environment = projectEnvironment()

  // Node leaves an already-set variable alone when it reads `--env-file`, so
  // this reaches the child even though the generated `.env` never mentions it.
  environment.WEB_BUNDLE_DIR = join(project, 'dist')

  const service = spawn('npm', ['start'], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
    detached: true,
  })
  const output: string[] = []

  service.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  service.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))

  const origin = `http://localhost:${API_PORT}`

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let ready = false

    while (Date.now() < deadline) {
      if (service.exitCode !== null) {
        throw new PackagingError(
          `The scaffolded service exited with ${service.exitCode} while serving its bundle.\n${output.join('')}`,
        )
      }

      const answer = await fetchOrUndefined(`${origin}/healthz`)

      if (answer !== undefined && answer.status === 200) {
        ready = true
        break
      }

      await delay(500)
    }

    if (!ready) {
      throw new PackagingError(
        `Nothing answered 200 on ${origin}/healthz within ${BOOT_TIMEOUT_MS / 1000}s with WEB_BUNDLE_DIR set. ` +
          `That is the API alone, with no dev server in front of it.\n${output.join('')}`,
      )
    }

    for (const path of ['/', '/signup', '/people/per_01JABCDEFGHJKMNPQRSTVWXYZ']) {
      const page = await fetchOrUndefined(`${origin}${path}`)

      if (page === undefined || page.status !== 200) {
        throw new PackagingError(
          `GET ${path} returned ${page?.status ?? 'nothing'} from the API. A deep link has to answer with ` +
            `index.html, because the app decides what to draw from the address.\n${output.join('')}`,
        )
      }

      const html = await page.text()

      if (!html.includes('<div id="root">')) {
        throw new PackagingError(`GET ${path} returned something other than the app shell:\n${html.slice(0, 500)}`)
      }
    }

    report('  the API serves the app shell at /, /signup, and a deep link')

    const scriptPath = firstBuiltScript(project)
    const asset = await fetchOrUndefined(`${origin}${scriptPath}`)

    if (asset === undefined || asset.status !== 200) {
      throw new PackagingError(`GET ${scriptPath} returned ${asset?.status ?? 'nothing'} from the API.`)
    }

    const assetType = asset.headers.get('content-type') ?? ''

    if (!assetType.includes('javascript')) {
      throw new PackagingError(`GET ${scriptPath} came back as ${assetType} rather than JavaScript.`)
    }

    report(`  built assets serve with their own content type (${scriptPath})`)

    // The rule the fallback is easiest to get wrong on. A bare catch-all would
    // answer this with the shell and a 200, telling a client nothing about the
    // endpoint it misspelled.
    //
    // The status is deliberately not pinned. Every toggleable module's router
    // carries a `/v1/*` gate that resolves the caller before routing, so an
    // unauthenticated request to an unknown path is `401` from the gate rather
    // than `404` from the router. Which of the two answers is a question for
    // auth, not for this check. What this check owns is that the answer is a
    // JSON error and not a web page.
    const missing = await fetchOrUndefined(`${origin}/v1/no-such-endpoint`)

    if (missing === undefined) {
      throw new PackagingError(`GET /v1/no-such-endpoint did not answer.\n${output.join('')}`)
    }

    const missingType = missing.headers.get('content-type') ?? ''

    if (missing.status === 200 || !missingType.includes('application/json')) {
      throw new PackagingError(
        `GET /v1/no-such-endpoint returned ${missing.status} as ${missingType || 'no content type'}. The ` +
          'single-page fallback is swallowing unknown API paths and answering them with the app shell.',
      )
    }

    report(`  an unknown API path is still a JSON error (${missing.status}), not the app shell`)
  } finally {
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

    report('\ntypechecking the scaffolded project')
    typecheckProject(project)

    report('\nbooting the scaffolded service')
    await bootAndSignUp(project)

    report('\nrunning the scaffolded migrate command')
    migrateAssembly(project)

    report('\nrunning the scaffolded reseal script')
    resealAssembly(project)

    report('\nbuilding the scaffolded web bundle')
    buildWithoutEnvironmentFile(project)
    assertThemeUtilitiesEmitted(project)

    report('\nserving the built bundle from the API, with no dev server in front of it')
    await serveBuiltBundle(project)

    report('\npackaging verified: create-kelpie writes a project that installs, boots, builds, and serves')
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
