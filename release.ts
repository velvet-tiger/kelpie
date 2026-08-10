/**
 * Cuts a release of `@kelpie/schemas`, `@kelpie/server`, and `@kelpie/ui`.
 *
 * The three share one version and go out together. An assembly pins all three,
 * and a mismatched pair has no meaning.
 *
 * The awkward part is the internal ranges. Every manifest depends on its
 * siblings through a caret range, and `^0.1.0` does not match `0.2.0`. Bumping
 * the versions without rewriting the ranges leaves npm looking on the registry
 * for a version that is not there yet, and it breaks `@kelpie/app` too, which is
 * private and never published. So versions and ranges move in one step.
 *
 *   npm run release 0.2.0            prepare, verify, commit, tag
 *   npm run release 0.2.0 --publish  the same, then publish to npm
 *
 * Without `--publish` it stops after tagging and prints the publish command.
 * Publishing is irreversible: npm allows unpublishing a new package for 72 hours
 * and not at all after that, so it is a deliberate second step rather than a
 * side effect of preparing one.
 *
 * The checks run against the manifests as they will ship, not as they were, so
 * the version write happens first. A failure then rolls the tree back. That is
 * only safe because a dirty tree is refused up front, which means the only
 * changes to discard are the ones this script made.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))

/** Every manifest carrying a version or an internal range. Order is irrelevant. */
const MANIFEST_DIRECTORIES = [
  '.',
  'packages/schemas',
  'packages/server',
  'packages/ui',
  'packages/create-kelpie',
  'apps/kelpie',
] as const

/**
 * The packages that actually go to npm. `@kelpie/app` and the root stay private.
 *
 * `create-kelpie` releases with the other three because a scaffold pins core at
 * the scaffolder's own version. Publishing it alone would write a manifest
 * asking for a core version that does not exist.
 */
const PUBLISHED_WORKSPACES = [
  'packages/schemas',
  'packages/server',
  'packages/ui',
  'packages/create-kelpie',
] as const

/** Checks that must pass before a release is tagged, in the order they run. */
const CHECKS: ReadonlyArray<readonly [label: string, script: string]> = [
  ['lint', 'lint'],
  ['typecheck', 'typecheck'],
  ['tests', 'test'],
  ['packaging', 'verify:packaging'],
]

const RELEASE_BRANCH = 'main'

/** A precondition failed. Reported as a message rather than a stack. */
class ReleaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseError'
  }
}

function report(message: string): void {
  process.stdout.write(`${message}\n`)
}

function capture(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
}

function run(command: string, args: readonly string[]): void {
  execFileSync(command, [...args], { cwd: repositoryRoot, stdio: 'inherit' })
}

function parseVersion(argv: readonly string[]): string {
  const version = argv.find((argument) => !argument.startsWith('-'))

  if (version === undefined) {
    throw new ReleaseError('Usage: npm run release <version> [--publish]. For example: npm run release 0.2.0')
  }

  // Deliberately strict. A leading "v" or a stray range character here would
  // reach the tag name and the internal ranges, where it is much harder to spot.
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleaseError(`"${version}" is not a plain semantic version. Write it as 1.2.3, with no leading "v".`)
  }

  return version
}

function assertReleasable(version: string): void {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])

  if (branch !== RELEASE_BRANCH) {
    throw new ReleaseError(`Releases are cut from ${RELEASE_BRANCH}. HEAD is on ${branch}.`)
  }

  if (capture('git', ['status', '--porcelain']).length > 0) {
    throw new ReleaseError('The working tree has uncommitted changes. Commit or stash them; a release tags what is committed.')
  }

  const tag = `v${version}`
  const existing = capture('git', ['tag', '--list', tag])

  if (existing.length > 0) {
    throw new ReleaseError(`Tag ${tag} already exists. Releases are immutable; pick the next version.`)
  }

  const changelog = readFileSync(join(repositoryRoot, 'CHANGELOG.md'), 'utf8')

  if (!changelog.includes(`## [${version}]`)) {
    throw new ReleaseError(
      `CHANGELOG.md has no "## [${version}]" section. Write the entry before cutting the release, not after.`,
    )
  }
}

/**
 * Rewrites the version and every internal `@kelpie/*` range in one manifest.
 * Returns whether anything changed, so the caller can report a manifest that was
 * somehow already at the target version rather than silently doing nothing.
 */
function applyVersion(directory: string, version: string): boolean {
  const path = join(repositoryRoot, directory, 'package.json')
  const before = readFileSync(path, 'utf8')
  const manifest: Record<string, unknown> = JSON.parse(before)

  manifest.version = version

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const group = manifest[field]

    if (typeof group !== 'object' || group === null) {
      continue
    }

    for (const name of Object.keys(group as Record<string, string>)) {
      if (name.startsWith('@kelpie/')) {
        ;(group as Record<string, string>)[name] = `^${version}`
      }
    }
  }

  const after = `${JSON.stringify(manifest, null, 2)}\n`

  writeFileSync(path, after)

  return before !== after
}

function main(): void {
  const argv = process.argv.slice(2)
  const version = parseVersion(argv)
  const publishing = argv.includes('--publish')
  const tag = `v${version}`

  assertReleasable(version)

  report(`setting every manifest to ${version}`)

  for (const directory of MANIFEST_DIRECTORIES) {
    const changed = applyVersion(directory, version)

    report(`  ${directory}/package.json${changed ? '' : ' (already current)'}`)
  }

  try {
    // The lockfile records the workspace versions, so it is part of the release
    // commit. `--package-lock-only` keeps this from touching node_modules.
    run('npm', ['install', '--package-lock-only'])

    for (const [label, script] of CHECKS) {
      report(`\nrunning ${label}`)

      try {
        run('npm', ['run', script])
      } catch {
        // The failing command has already written its own diagnosis to the
        // terminal. Rethrowing what execFileSync raises would bury that under a
        // stack trace through this file, which explains nothing.
        throw new ReleaseError(`${label} failed. Its output is above.`)
      }
    }
  } catch (error: unknown) {
    run('git', ['checkout', '--', '.'])

    const rolledBack = 'The version changes have been rolled back and nothing was tagged.'

    if (error instanceof ReleaseError) {
      throw new ReleaseError(`\n${error.message}\n${rolledBack}`)
    }

    report(`\n${rolledBack}`)

    throw error
  }

  run('git', ['add', '-A'])
  run('git', ['commit', '-m', `chore(release): ${tag}`])
  run('git', ['tag', '-a', tag, '-m', tag])

  report(`\ncommitted and tagged ${tag}`)

  if (!publishing) {
    report('\nNothing has been published. To publish this tag:')
    report(`  npm publish ${PUBLISHED_WORKSPACES.map((workspace) => `--workspace ${workspace}`).join(' ')}`)
    report('\nThat step is irreversible. npm allows unpublishing a new package for 72 hours and not at all after that.')

    return
  }

  report('\npublishing to npm')
  run('npm', ['publish', ...PUBLISHED_WORKSPACES.flatMap((workspace) => ['--workspace', workspace])])
  report(`\npublished ${version}`)
}

try {
  main()
} catch (error: unknown) {
  if (error instanceof ReleaseError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }

  throw error
}
