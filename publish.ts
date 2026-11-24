/**
 * Publishes the packages that go to npm, skipping any already there.
 *
 * A plain `npm publish --workspace a --workspace b` is all-or-nothing: it stops
 * on the first package whose version exists, and leaves the rest unpublished. It
 * has no way back from a partial release either, which is not hypothetical.
 * `0.2.0` of the three `@kelpie` packages went out without `create-kelpie`, and
 * republishing to catch it up failed on the three that had already landed.
 *
 * So this asks the registry what is there and publishes only the difference.
 * Running it twice is a no-op, running it after a partial release finishes the
 * job, and either way it says what it skipped rather than implying it did more
 * than it did.
 *
 *   make publish            (or: npm run publish:packages)
 *
 * It builds every package immediately before publishing, then refuses to
 * publish a package whose tarball lacks a file its `bin` or `exports` names.
 * `publish` never builds on its own, and the `dist` a release verified can be
 * gone by the time someone publishes: a disk-cleaning tool deleted it once,
 * and `0.25.0` went out as source only. npm warns about a missing bin and
 * publishes anyway, so the check has to live here.
 *
 * Publishing cannot be undone. npm allows unpublishing a new package for 72
 * hours and not at all after that, and an unpublished version can never be
 * republished under the same name. That is a version number spent for good.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * The packages that go to npm, and the only place that list lives. `@kelpie/app`
 * and the root stay private.
 *
 * `create-kelpie` belongs with the other three: a scaffold it writes pins core
 * at the scaffolder's own version, so a release without it leaves
 * `npm create kelpie` either absent or writing projects that ask for a version
 * nobody published.
 */
const PUBLISHED_WORKSPACES = [
  'packages/schemas',
  'packages/server',
  'packages/ui',
  'packages/create-kelpie',
] as const

const REGISTRY = 'https://registry.npmjs.org'

/** A precondition failed. Reported as a message rather than a stack. */
class PublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishError'
  }
}

interface Package {
  readonly directory: string
  readonly name: string
  readonly version: string
}

function report(message: string): void {
  process.stdout.write(`${message}\n`)
}

function readPackage(directory: string): Package {
  const path = join(repositoryRoot, directory, 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))

  if (typeof parsed !== 'object' || parsed === null) {
    throw new PublishError(`${path} does not contain a JSON object.`)
  }

  const { name, version } = parsed as { name?: unknown; version?: unknown }

  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new PublishError(`${path} is missing "name" or "version".`)
  }

  return { directory, name, version }
}

/**
 * Whether the registry already holds this exact version.
 *
 * Asks the registry over HTTPS rather than through `npm view`. On this machine
 * npm is wrapped by a supply-chain tool that suppresses recently published
 * versions and then reports E404, which is indistinguishable from a package that
 * was never published. Deciding whether to publish on that answer would
 * republish something already live, or skip something missing.
 */
async function isPublished({ name, version }: Package): Promise<boolean> {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/json' },
  })

  if (response.status === 404) {
    return false
  }

  if (!response.ok) {
    throw new PublishError(`The registry answered ${response.status} for ${name}. Try again when it is reachable.`)
  }

  const body: unknown = await response.json()
  const versions = (body as { versions?: Record<string, unknown> }).versions ?? {}

  return version in versions
}

/**
 * Builds one package with its own `build` script. Every package is built, not
 * only the pending ones, because a package compiles against its siblings'
 * `dist`.
 */
function buildPackage({ directory, name }: Package): void {
  report(`  building ${name}`)
  execFileSync('npm', ['run', 'build', '--workspace', directory], { cwd: repositoryRoot, stdio: 'inherit' })
}

/** Every path a manifest's `bin` and `exports` name, without a leading `./`. */
function declaredFiles(directory: string): string[] {
  const path = join(repositoryRoot, directory, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { bin?: unknown; exports?: unknown }
  const found: string[] = []

  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      found.push(value.replace(/^\.\//, ''))
    } else if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) {
        collect(child)
      }
    }
  }

  collect(manifest.bin)
  collect(manifest.exports)

  return found
}

/** The paths `npm pack` would put in this package's tarball. */
function packedFiles({ directory, name }: Package): Set<string> {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--workspace', directory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const parsed: unknown = JSON.parse(output)
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined
  const files = (first as { files?: unknown } | undefined)?.files

  if (!Array.isArray(files)) {
    throw new PublishError(`npm pack --dry-run gave no file list for ${name}.`)
  }

  return new Set(files.map((file: { path?: unknown }) => String(file.path)))
}

/**
 * Refuses to go on when the tarball would miss a file the manifest points at.
 * Checked against the pack list rather than the disk, so a `files` entry that
 * leaves a built file out is caught as well as a build that never ran.
 */
function requireDeclaredFilesPacked(entry: Package): void {
  const packed = packedFiles(entry)
  const missing = declaredFiles(entry.directory).filter((file) => !packed.has(file))

  if (missing.length > 0) {
    throw new PublishError(
      `${entry.name}@${entry.version} would ship without ${missing.join(', ')}, which its bin or exports name. ` +
        'Nothing has been published.',
    )
  }

  report(`  ${entry.name}: every bin and exports file is in the tarball`)
}

async function main(): Promise<void> {
  const packages = PUBLISHED_WORKSPACES.map(readPackage)
  const versions = new Set(packages.map((entry) => entry.version))

  if (versions.size > 1) {
    throw new PublishError(
      `The packages are at different versions: ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}. ` +
        'They release together. Run `npm run release <version>` to bring them into line.',
    )
  }

  const [version] = versions

  report(`Checking what the registry already has at ${version}.\n`)

  const pending: Package[] = []

  for (const entry of packages) {
    if (await isPublished(entry)) {
      report(`  ${entry.name}@${entry.version} is already published, skipping`)
    } else {
      pending.push(entry)
    }
  }

  if (pending.length === 0) {
    report(`\nEverything is already on npm at ${version}. Nothing to do.`)

    return
  }

  report(`\nPublishing ${pending.length} of ${packages.length}:`)

  for (const entry of pending) {
    report(`  ${entry.name}@${entry.version}`)
  }

  report('\nBuilding every package, so the tarballs carry a fresh dist.\n')

  for (const entry of packages) {
    buildPackage(entry)
  }

  for (const entry of pending) {
    requireDeclaredFilesPacked(entry)
  }

  report('\nThis cannot be undone. An unpublished version can never be published again under the same name.\n')

  for (const entry of pending) {
    execFileSync('npm', ['publish', '--workspace', entry.directory], { cwd: repositoryRoot, stdio: 'inherit' })
  }

  report(`\nPublished ${pending.length} package${pending.length === 1 ? '' : 's'} at ${version}.`)
}

try {
  await main()
} catch (error: unknown) {
  if (error instanceof PublishError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }

  throw error
}
