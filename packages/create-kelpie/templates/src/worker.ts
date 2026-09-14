import {
  ConfigurationError,
  ModuleBootError,
  ModuleConfigFileError,
  bootAssembly,
  startWorker,
} from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * The worker entry point. Runs the pg-boss consumer without ever calling
 * `createApp`, so there is no HTTP surface here.
 *
 * The default deployment runs the work loops inline from `src/server.ts`, so
 * one container both serves and works. Start this process alongside a
 * `server.ts` running with `--no-worker` when the two should scale on their
 * own — for example, when a slow handler must not compete with request
 * handling. Both processes share the same image, the same secrets, and the
 * same `@kelpie/server` build.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function main(): Promise<void> {
  const boot = await bootAssembly(kelpieConfig, process.env)

  await startWorker(boot)

  const shutdown = (signal: string): void => {
    boot.logger.info('shutting down worker', { signal })
    void boot.jobs
      .stop()
      .then(() => boot.contributions.events.drain())
      .then(() => boot.database.close())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        boot.logger.error('worker shutdown failed', { error })
        process.exit(1)
      })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

try {
  await main()
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

  throw error
}
