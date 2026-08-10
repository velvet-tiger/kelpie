/**
 * Proves that `@kelpie/server`, `@kelpie/ui`, and `@kelpie/schemas` work when
 * installed somewhere that is not this workspace.
 *
 * Inside the workspace they always work, and that proves nothing: npm symlinks
 * `node_modules/@kelpie/server` to `packages/server`, and Node resolves the
 * symlink before it strips types, so the file it loads is never actually under
 * `node_modules`. From a real install it would be, and Node refuses to strip
 * types there (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The only way to
 * catch that is to pack the tarballs and install them out of tree, which is what
 * this does.
 *
 * It builds, packs, installs into a scratch directory under the system temp
 * directory, and then asserts the three things that break silently:
 *
 *   1. `@kelpie/server` imports, so the compiled entry point is the one shipped.
 *   2. `coreMigrationsDirectory` points at real migrations, so a consumer can
 *      boot. Drizzle reads `meta/_journal.json` and the `.sql` files at runtime,
 *      and that directory is outside `dist`, so only `files` puts it in the
 *      tarball.
 *   3. A Vite build against `@kelpie/ui` emits the theme utilities. Tailwind
 *      ignores `node_modules` during automatic source detection, so if the
 *      `@source` in `styles.css` does not reach the components beside it, the
 *      build still succeeds and every page ships unstyled.
 *
 * Run it with `npm run verify:packaging`. Set `KELPIE_KEEP_SCRATCH=1` to leave
 * the scratch directory behind for inspection.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))

/** The packages under test, in dependency order. */
const PACKAGE_DIRECTORIES = ['packages/schemas', 'packages/server', 'packages/ui'] as const

/**
 * Theme utilities that exist only if Tailwind scanned the Kelpie components. The
 * `@theme` block declares the tokens, but a utility is emitted only where a
 * class naming it appears in scanned source, and the scratch app below names
 * none of these itself.
 */
const REQUIRED_UTILITIES = ['.bg-surface-raised', '.text-ink-faint', '.bg-sidebar-active'] as const

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
 * Reads a dependency's version range out of a workspace manifest, so the scratch
 * app installs the same versions this repository develops against rather than a
 * second set that can drift out of step with it.
 */
function versionOf(manifest: PackageManifest, dependency: string): string {
  const range = manifest.dependencies?.[dependency] ?? manifest.devDependencies?.[dependency]

  if (range === undefined) {
    throw new PackagingError(`${manifest.name} does not depend on ${dependency}; this script needs its version.`)
  }

  return range
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

function writeScratchApp(directory: string, tarballs: ReadonlyMap<string, string>): void {
  const uiManifest = readManifest(join(repositoryRoot, 'packages/ui'))
  const appManifest = readManifest(join(repositoryRoot, 'apps/kelpie'))

  const tarballOf = (name: string): string => {
    const path = tarballs.get(name)

    if (path === undefined) {
      throw new PackagingError(`No tarball was packed for ${name}.`)
    }

    return `file:${path}`
  }

  /*
   * `overrides` pins the transitive `@kelpie/schemas` that server and ui both
   * declare. Their manifests name a version range, which npm would look for on
   * the registry; here it has to come from the tarball beside them. A consumer
   * installing published packages needs none of this.
   */
  const manifest = {
    name: 'kelpie-packaging-scratch',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@kelpie/schemas': tarballOf('@kelpie/schemas'),
      '@kelpie/server': tarballOf('@kelpie/server'),
      '@kelpie/ui': tarballOf('@kelpie/ui'),
      '@hono/node-server': versionOf(appManifest, '@hono/node-server'),
      react: versionOf(uiManifest, 'react'),
      'react-dom': versionOf(uiManifest, 'react-dom'),
    },
    devDependencies: {
      '@tailwindcss/vite': versionOf(appManifest, '@tailwindcss/vite'),
      '@vitejs/plugin-react': versionOf(appManifest, '@vitejs/plugin-react'),
      tailwindcss: versionOf(uiManifest, 'tailwindcss'),
      vite: versionOf(appManifest, 'vite'),
    },
    overrides: {
      '@kelpie/schemas': tarballOf('@kelpie/schemas'),
    },
  }

  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  writeFileSync(
    join(directory, 'vite.config.ts'),
    `import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [react(), tailwindcss()], logLevel: 'warn' })
`,
  )

  // No Tailwind classes of its own, so every utility in the built CSS came from
  // scanning the installed package.
  writeFileSync(
    join(directory, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>scratch</title></head>
  <body><div id="root"></div><script type="module" src="/main.tsx"></script></body>
</html>
`,
  )

  writeFileSync(
    join(directory, 'main.tsx'),
    `import { KelpieApp, registerUiModules } from '@kelpie/ui'
import '@kelpie/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Expected an element with id "root"')
}

createRoot(container).render(
  <StrictMode>
    <KelpieApp extensions={registerUiModules([])} />
  </StrictMode>,
)
`,
  )

  /*
   * Run as a separate process rather than imported here: this file runs inside
   * the workspace, where `@kelpie/server` resolves to the symlinked source and
   * would prove nothing.
   */
  writeFileSync(
    join(directory, 'check-server.js'),
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

function assertThemeUtilitiesEmitted(directory: string): void {
  const assets = join(directory, 'dist', 'assets')

  if (!existsSync(assets)) {
    throw new PackagingError(`The scratch build produced no ${assets}.`)
  }

  const stylesheets = readdirSync(assets).filter((entry) => entry.endsWith('.css'))

  if (stylesheets.length === 0) {
    throw new PackagingError(`The scratch build emitted no CSS into ${assets}.`)
  }

  const css = stylesheets.map((entry) => readFileSync(join(assets, entry), 'utf8')).join('\n')
  const missing = REQUIRED_UTILITIES.filter((utility) => !css.includes(utility))

  if (missing.length > 0) {
    throw new PackagingError(
      `The scratch build emitted CSS without ${missing.join(', ')}. Tailwind did not scan the ` +
        'components in @kelpie/ui. It ignores node_modules during automatic source detection, so ' +
        'the @source in styles.css has to reach them and the "files" field has to ship them.',
    )
  }

  report(`  ui builds, ${REQUIRED_UTILITIES.length} theme utilities present in the CSS`)
}

function main(): void {
  const scratch = mkdtempSync(join(tmpdir(), 'kelpie-packaging-'))
  const tarballDirectory = join(scratch, 'tarballs')
  const app = join(scratch, 'app')

  mkdirSync(tarballDirectory)
  mkdirSync(app)

  try {
    const tarballs = packPackages(tarballDirectory)

    writeScratchApp(app, tarballs)

    report(`installing into ${app}`)
    run('npm', ['install', '--no-audit', '--no-fund'], app)

    report('checking @kelpie/server')
    run('node', ['check-server.js'], app)

    report('checking @kelpie/ui')
    run('npx', ['vite', 'build'], app)
    assertThemeUtilitiesEmitted(app)

    report('\npackaging verified: the tarballs install and work outside this workspace')
  } finally {
    if (process.env.KELPIE_KEEP_SCRATCH === undefined) {
      rmSync(scratch, { recursive: true, force: true })
    } else {
      report(`scratch directory kept at ${scratch}`)
    }
  }
}

try {
  main()
} catch (error: unknown) {
  if (error instanceof PackagingError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }

  throw error
}
