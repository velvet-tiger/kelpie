import { serve } from '@hono/node-server'
import {
  ConfigurationError,
  ModuleBootError,
  connectDatabase,
  createApp,
  createLogger,
  loadConfig,
  registerModules,
  runMigrations,
} from '@kelpie/server'

import { modules } from '../kelpie.config.ts'

/**
 * The open-source assembly's entry point. It reads the environment, registers
 * the configured modules, applies migrations, wires the dependencies, and serves.
 *
 * Registration runs before migrations, which reverses `architecture.md` boot
 * steps 2 and 3. It has to: modules declare their migrations directory during
 * `register`, so there is nothing to migrate until the pass has run. Registration
 * touches no database.
 *
 * `--no-migrate` skips the migration step, for deployments where a release step
 * migrates once and many instances then start.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function start(): Promise<void> {
  const config = loadConfig(process.env)
  const logger = createLogger(config.logLevel)
  const database = connectDatabase(config.databaseUrl)
  const contributions = await registerModules({ modules, environment: process.env, logger })

  if (process.argv.includes('--no-migrate')) {
    logger.info('skipping migrations', { reason: '--no-migrate' })
  } else {
    await runMigrations(database.db, contributions.schemas, logger)
  }

  const app = createApp({ logger, probeDatabase: database.probe, contributions })

  const server = serve({ fetch: app.fetch, port: config.port }, (address) => {
    logger.info('listening', { port: address.port, runtimeMode: config.runtimeMode })
  })

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal })
    server.close(() => {
      void database.close().then(() => process.exit(0))
    })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

try {
  await start()
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    reportFatal(error.message)
    reportFatal('Copy .env.example to .env and fill it in, or set these variables in the environment.')
    process.exit(1)
  }

  if (error instanceof ModuleBootError) {
    reportFatal(error.message)
    reportFatal('Fix the module list in apps/kelpie/kelpie.config.ts, or the configuration it needs.')
    process.exit(1)
  }

  throw error
}
