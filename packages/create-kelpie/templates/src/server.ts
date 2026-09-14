import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  ConfigurationError,
  ModuleBootError,
  ModuleConfigFileError,
  WebBundleError,
  bootAssembly,
  createApp,
  resolveClientIpFrom,
  runMigrations,
  serveWebBundle,
  startWorker,
} from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * The entry point. It reads the environment, registers the configured modules,
 * applies migrations, wires the dependencies, and serves.
 *
 * The config, database, and registration pass come from `bootAssembly`, shared
 * with the standalone `migrate` command. Registration runs before migrations:
 * modules declare their migrations directory while registering, so there is
 * nothing to migrate until that pass has finished.
 *
 * `--no-migrate` skips the migration step, for deployments where `npm run migrate`
 * migrates once in a release step and many instances then start.
 *
 * `--no-worker` skips the pg-boss `work()` loops. This process still opens the
 * boss instance so a service can enqueue jobs inside its own transaction; the
 * work loops themselves live in the separate `worker` process (`src/worker.ts`).
 * The default is to run both inline, so one container both serves and works.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function start(): Promise<void> {
  const boot = await bootAssembly(kelpieConfig, process.env)
  const { config, logger, database, createId, credentials, contributions, jobs } = boot

  if (process.argv.includes('--no-migrate')) {
    logger.info('skipping migrations', { reason: '--no-migrate' })
  } else {
    await runMigrations(database.db, contributions.schemas, logger)
    await jobs.migrate()
  }

  // The API always opens a boss instance: a service enqueues jobs inside its
  // own transaction on request, so `boss.send` must be reachable even when
  // this process runs no work loops. `startWorker` on top adds the `work()`
  // calls; `--no-worker` skips them, for deployments that run a separate
  // `src/worker.ts` process alongside.
  if (process.argv.includes('--no-worker')) {
    logger.info('skipping inline worker', { reason: '--no-worker' })
    await jobs.start()
  } else {
    await startWorker(boot)
  }

  const app = createApp({
    logger,
    probeDatabase: database.probe,
    contributions,
    credentials,
    createId,
    rateLimit: config.rateLimit,
    runtimeMode: config.runtimeMode,
    siteName: config.siteName,
    // The socket address, then `X-Forwarded-For` only as far as the configured
    // number of trusted proxies allows. Resolved from the connection itself
    // rather than defaulted inside `createApp`, and trusting the header any
    // further than `TRUSTED_PROXY_HOP_COUNT` would be spoofable.
    resolveClientIp: (context) =>
      resolveClientIpFrom(
        getConnInfo(context).remote.address ?? 'unknown',
        context.req.header('X-Forwarded-For'),
        config.trustedProxyHopCount,
      ),
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
      // Order: stop the job worker (waits for in-flight jobs), drain the event
      // bus (which may still be delivering post-commit handlers), then close
      // the database.
      void jobs
        .stop()
        .then(() => contributions.events.drain())
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
