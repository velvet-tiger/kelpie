import {
  ConfigurationError,
  ModuleBootError,
  ModuleConfigFileError,
  bootAssembly,
  runMigrations,
} from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * Applies every pending migration, then exits.
 *
 * This is the release step `--no-migrate` expects: run it once before starting
 * instances that skip boot-time migration, so applying migrations is not a race
 * between them. Registration runs first, because modules declare their
 * migrations directory while registering and there is nothing to migrate until
 * that pass has finished. Migrations are forward-only and safe to re-run; a
 * second run is a no-op.
 *
 * The body stays this small because `bootAssembly` owns the wiring the server
 * entry point also needs. A future `kelpie` CLI turns this into a subcommand
 * and the body does not change.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function migrate(): Promise<void> {
  const { database, contributions, logger } = await bootAssembly(kelpieConfig, process.env)

  try {
    await runMigrations(database.db, contributions.schemas, logger)
  } finally {
    await database.close()
  }
}

try {
  await migrate()
  process.exit(0)
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    reportFatal(error.message)
    reportFatal('Copy .env.example to .env and fill it in, or set these variables in the environment.')
    process.exit(1)
  }

  if (error instanceof ModuleConfigFileError) {
    reportFatal(error.message)
    reportFatal('Fix the file at KELPIE_MODULE_CONFIG_PATH, or unset it to let workspaces decide for themselves.')
    process.exit(1)
  }

  if (error instanceof ModuleBootError) {
    reportFatal(error.message)
    reportFatal('Fix the module list in apps/kelpie/kelpie.config.ts, or the configuration it needs.')
    process.exit(1)
  }

  throw error
}
