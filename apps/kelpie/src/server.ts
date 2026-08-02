import { serve } from '@hono/node-server'
import {
  ConfigurationError,
  ModuleBootError,
  connectDatabase,
  createApp,
  createLogger,
  loadConfig,
  registerModules,
} from '@kelpie/server'

import { modules } from '../kelpie.config.ts'

/**
 * The open-source assembly's entry point. It reads the environment, registers
 * the configured modules, wires the dependencies, and serves.
 *
 * TODO(phase-0): run pending migrations between config and registration
 * (architecture.md boot step 2) once the schema feature creates a migrations
 * pipeline. The registration pass already collects each module's tables and
 * migrations directory.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function start(): Promise<void> {
  const config = loadConfig(process.env)
  const logger = createLogger(config.logLevel)
  const database = connectDatabase(config.databaseUrl)
  const contributions = await registerModules({ modules, environment: process.env, logger })
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
