import { serve } from '@hono/node-server'
import { ConfigurationError, connectDatabase, createApp, createLogger, loadConfig } from '@kelpie/server'

/**
 * The open-source assembly's entry point. It reads the environment, wires the
 * dependencies, and serves. Feature composition moves into `kelpie.config.ts`
 * when the module runtime lands.
 *
 * TODO(phase-0): run pending migrations here (architecture.md boot step 2) once
 * the schema feature creates a migrations pipeline.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

function start(): void {
  const config = loadConfig(process.env)
  const logger = createLogger(config.logLevel)
  const database = connectDatabase(config.databaseUrl)
  const app = createApp({ logger, probeDatabase: database.probe })

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
  start()
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    reportFatal(error.message)
    reportFatal('Copy .env.example to .env and fill it in, or set these variables in the environment.')
    process.exit(1)
  }

  throw error
}
