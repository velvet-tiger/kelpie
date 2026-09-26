import {
  ConfigurationError,
  createLogger,
  createTransportForDestination,
  resealAiSecrets,
  resolveKelpieConfig,
  runReseal,
} from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * Re-seals stored secrets after `SECRET_ENCRYPTION_KEY` changes.
 *
 * The rotation procedure lives on `runReseal`'s JSDoc; this file only wires
 * the assembly's config in and hands `ConfigurationError` a fix hint on the
 * way out. A future `kelpie` CLI turns this into a subcommand and the body
 * stays the same size.
 */

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

try {
  const config = resolveKelpieConfig(kelpieConfig, process.env)
  const logger = createLogger({
    level: config.logging.level,
    transports: config.logging.destinations.map(createTransportForDestination),
  })
  // The `ai` module is optional, so core's own pass cannot see its table.
  // Remove this pass with the module.
  process.exit(await runReseal({ config, logger, extraPasses: [resealAiSecrets] }))
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    reportFatal(error.message)
    reportFatal('Set SECRET_ENCRYPTION_KEY, and SECRET_ENCRYPTION_KEY_PREVIOUS if you are mid-rotation.')
    process.exit(1)
  }

  throw error
}
