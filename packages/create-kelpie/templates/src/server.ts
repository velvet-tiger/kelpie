import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  ConfigurationError,
  ModuleBootError,
  ModuleConfigFileError,
  WebBundleError,
  connectDatabase,
  createApp,
  createEmailSender,
  createEventBus,
  createIdFactory,
  createLogger,
  createTransactionScope,
  loadConfig,
  readModuleConfigFile,
  registerModules,
  resolveActorFrom,
  runMigrations,
  serveWebBundle,
} from '@kelpie/server'
import type { CredentialDependencies } from '@kelpie/server'

import { modules } from '../kelpie.config.ts'

/**
 * The entry point. It reads the environment, registers the configured modules,
 * applies migrations, wires the dependencies, and serves.
 *
 * Registration runs before migrations. Modules declare their migrations
 * directory while registering, so there is nothing to migrate until that pass
 * has finished.
 *
 * `--no-migrate` skips the migration step, for deployments where one release
 * step migrates and many instances then start.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function start(): Promise<void> {
  const config = loadConfig(process.env)
  const logger = createLogger(config.logLevel)
  const database = connectDatabase(config.databaseUrl, logger)
  const events = createEventBus(logger)
  const createId = createIdFactory()
  const credentials: CredentialDependencies = { db: database.db, now: () => new Date() }
  const moduleConfig = readModuleConfigFile(config.moduleConfigPath)
  const contributions = await registerModules({
    modules,
    environment: process.env,
    logger,
    events,
    moduleConfig,
    resolveActor: (context) => resolveActorFrom(credentials, context),
    services: {
      db: database.db,
      transaction: createTransactionScope({ db: database.db, bus: events, logger }),
      email: createEmailSender(config.email, logger),
      createId,
      now: () => new Date(),
    },
  })

  if (process.argv.includes('--no-migrate')) {
    logger.info('skipping migrations', { reason: '--no-migrate' })
  } else {
    await runMigrations(database.db, contributions.schemas, logger)
  }

  const app = createApp({
    logger,
    probeDatabase: database.probe,
    contributions,
    credentials,
    createId,
    rateLimit: config.rateLimit,
    // The real socket address. A header-based fallback would be spoofable, so
    // this is resolved from the connection itself rather than defaulted
    // inside `createApp`.
    resolveClientIp: (context) => getConnInfo(context).remote.address ?? 'unknown',
    superuserEmails: config.superuserEmails,
  })

  // After `createApp`, so every API route is registered ahead of the fallback.
  // Unset while developing, where the Vite dev server builds the pages itself
  // and proxies `/v1` here. Set it in a deployment, after `npm run build`, and
  // one process serves the pages and the API on one address.
  if (config.webBundleDirectory !== undefined) {
    serveWebBundle(app, { directory: config.webBundleDirectory })
    logger.info('serving web bundle', { directory: config.webBundleDirectory })
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (address) => {
    logger.info('listening', { port: address.port, runtimeMode: config.runtimeMode })
  })

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal })
    server.close(() => {
      // Drain before closing the pool: a handler mid-flight may still be writing.
      void contributions.events
        .drain()
        .then(() => database.close())
        .then(() => process.exit(0))
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
    reportFatal('Check .env against the table in README.md.')
    process.exit(1)
  }

  if (error instanceof ModuleConfigFileError) {
    reportFatal(error.message)
    reportFatal('Fix the file at KELPIE_MODULE_CONFIG_PATH, or unset it to let workspaces decide for themselves.')
    process.exit(1)
  }

  if (error instanceof ModuleBootError) {
    reportFatal(error.message)
    reportFatal('Fix the module list in kelpie.config.ts, or the configuration it needs.')
    process.exit(1)
  }

  if (error instanceof WebBundleError) {
    reportFatal(error.message)
    reportFatal('Run `npm run build` to produce one, or unset WEB_BUNDLE_DIR to serve the API alone.')
    process.exit(1)
  }

  throw error
}
