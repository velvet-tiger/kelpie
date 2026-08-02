import type { Hono } from 'hono'

import { createApp } from '../app.ts'
import type { AppBindings } from '../app.ts'
import type { Environment } from '../lib/config.ts'
import type { DatabaseProbe } from '../lib/database.ts'
import { createLogger } from '../lib/logger.ts'
import type { KelpieModule } from '../runtime/module.ts'
import type { ModuleContributions } from '../runtime/registry.ts'
import type { EntitlementRegistry } from '../runtime/entitlements.ts'
import { registerModules } from '../runtime/registry.ts'
import { createTestServices } from './services.ts'
import type { TestServices } from './services.ts'

/**
 * Assembles an app for tests. Unlike the real boot it defaults every dependency,
 * because a test that has to spell out an environment it does not care about
 * tests the harness instead of the code.
 */

export interface TestAppOptions {
  readonly modules?: readonly KelpieModule[]
  readonly environment?: Environment
  readonly probeDatabase?: () => Promise<DatabaseProbe>
  readonly generateRequestId?: () => string
  /** Defaults to fakes: a lazy unused database and a collecting email sender. */
  readonly services?: TestServices
  /** Inject one to grant or deny capabilities before core modules register. */
  readonly entitlements?: EntitlementRegistry
}

export interface TestApp {
  readonly app: Hono<AppBindings>
  readonly services: TestServices
  readonly contributions: ModuleContributions
  /** Every log line the app emitted, newest last. */
  readonly logLines: readonly string[]
}

const reachableDatabase = (): Promise<DatabaseProbe> => Promise.resolve({ reachable: true })

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const logLines: string[] = []
  const logger = createLogger('debug', (line) => logLines.push(line))

  const services = options.services ?? createTestServices()
  const contributions = await registerModules({
    modules: options.modules ?? [],
    environment: options.environment ?? {},
    logger,
    events: services.events,
    ...(options.entitlements === undefined ? {} : { entitlements: options.entitlements }),
    services,
  })

  const app = createApp({
    logger,
    probeDatabase: options.probeDatabase ?? reachableDatabase,
    contributions,
    generateRequestId: options.generateRequestId ?? (() => 'req-test'),
  })

  return { app, contributions, logLines, services }
}
