import type { Environment, KelpieConfig } from './lib/config.ts'
import { connectDatabase } from './lib/database.ts'
import type { DatabaseConnection } from './lib/database.ts'
import { createIdFactory } from './lib/ids.ts'
import type { IdFactory } from './lib/ids.ts'
import { resolveKelpieConfig } from './lib/kelpieConfigFile.ts'
import type { KelpieConfigInput } from './lib/kelpieConfigFile.ts'
import { createLogger, createTransportForDestination } from './lib/logger.ts'
import type { Logger } from './lib/logger.ts'
import { readModuleConfigFile } from './lib/moduleConfig.ts'
import { resolveActorFrom } from './modules/auth/credentials.ts'
import type { CredentialDependencies } from './modules/auth/credentials.ts'
import { createEventBus } from './runtime/events.ts'
import { registerModules } from './runtime/registry.ts'
import type { ModuleContributions } from './runtime/registry.ts'
import { createTransactionScope } from './runtime/transaction.ts'

/**
 * A resolved assembly: config parsed, database connected, modules registered.
 *
 * This is the common prelude every entry point needs before it does its own
 * work. `server.ts` goes on to build the app and serve; `migrate.ts` goes on to
 * apply migrations and exit. Both start here, so the wiring lives in one place
 * rather than drifting between two copies.
 *
 * The database is connected but not opened: postgres.js connects lazily, and
 * registration issues no query, so a caller that only needs the contributions
 * pays for no connection. The caller owns `database.close()`.
 */
export interface AssemblyBoot {
  readonly config: KelpieConfig
  readonly logger: Logger
  readonly database: DatabaseConnection
  readonly createId: IdFactory
  readonly credentials: CredentialDependencies
  readonly contributions: ModuleContributions
}

/**
 * Resolves an assembly's config, connects the database, and runs the module
 * registration pass.
 *
 * Registration touches no database. It only collects what the modules
 * contribute, migrations directories included, which is why an entry point can
 * call this and then decide whether to serve, migrate, or both.
 *
 * @throws ConfigurationError when a required variable is missing or malformed.
 * @throws ModuleConfigFileError when the module override file cannot be read.
 * @throws ModuleBootError when the module list is invalid or a module fails to
 *   register. The caller maps these to a fix hint and an exit code.
 */
export async function bootAssembly(
  kelpieConfig: KelpieConfigInput,
  environment: Environment,
): Promise<AssemblyBoot> {
  const config = resolveKelpieConfig(kelpieConfig, environment)
  const logger = createLogger({
    level: config.logging.level,
    transports: config.logging.destinations.map(createTransportForDestination),
  })
  const database = connectDatabase(config.databaseUrl, logger)
  const events = createEventBus(logger)
  const createId = createIdFactory()
  const credentials: CredentialDependencies = { db: database.db, now: () => new Date() }
  const moduleConfig = readModuleConfigFile(config.moduleConfigPath)
  const contributions = await registerModules({
    modules: kelpieConfig.modules,
    environment: config.env,
    logger,
    events,
    moduleConfig,
    resolveActor: (context) => resolveActorFrom(credentials, context),
    services: {
      db: database.db,
      transaction: createTransactionScope({ db: database.db, bus: events, logger, createId }),
      createId,
      now: () => new Date(),
      appBaseUrl: config.appBaseUrl,
      secretEncryption: config.secretEncryption,
    },
    // `provider` picks a named sender from the runtime's registry. `'log'` is
    // built in; `'smtp'` is registered by the built-in `smtp-email` core
    // module; other names come from third-party provider modules listed in
    // `kelpie.config.ts`. `from` is the address on every outgoing message.
    email: { provider: config.email.EMAIL_PROVIDER, from: config.email.EMAIL_FROM },
  })

  return { config, logger, database, createId, credentials, contributions }
}
