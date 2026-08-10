#!/usr/bin/env node

/**
 * `npm create kelpie` lands here.
 *
 * It writes an assembly and stops. It does not run `npm install`, start
 * Postgres, or boot anything: the generated README says what to do next, and a
 * scaffolder that installs for you is a scaffolder you cannot read the output
 * of when the install fails.
 */

import { relative } from 'node:path'

import { USAGE, parseArguments, resolveOptions } from './options.ts'
import { ScaffoldError, scaffold } from './scaffold.ts'

function report(message: string): void {
  process.stdout.write(`${message}\n`)
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2))

  if (parsed.help) {
    report(USAGE)

    return
  }

  const options = await resolveOptions(parsed, process.stdin.isTTY === true)
  const written = scaffold(options)
  const here = relative(process.cwd(), options.directory) || '.'

  report(`\nWrote ${written.length} files into ${here}/`)
  report('')
  report('Next:')
  report(`  cd ${here}`)
  report('  npm install')

  if (options.docker) {
    report('  docker compose up --detach --wait')
  }

  report('  npm run dev')
  report('')
  report(`Then open http://localhost:${options.webPort}/signup to create your account.`)
  report(`${here}/README.md has the rest, including what every variable in .env does.`)
}

try {
  await main()
} catch (error: unknown) {
  if (error instanceof ScaffoldError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }

  throw error
}
