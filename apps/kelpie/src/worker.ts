import {
  ConfigurationError,
  ModuleBootError,
  ModuleConfigFileError,
  bootAssembly,
  startWorker,
} from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * The open-source assembly's worker entry point.
 *
 * Runs the pg-boss consumer without ever calling `createApp`. Cloud runs this
 * as a separate Fly process group; the OSS server (`server.ts`) also runs it
 * inline unless started with `--no-worker`, so one container serves and works
 * by default.
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
