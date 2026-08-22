import type { Context, Hono } from 'hono'

import { createApp } from '../app.ts'
import type { AppBindings } from '../app.ts'
import type { Actor } from '../lib/actor.ts'
import type { Environment } from '../lib/config.ts'
import type { DatabaseProbe } from '../lib/database.ts'
import { createCaptureTransport, createLogger } from '../lib/logger.ts'
import { rateLimitConfigFrom, rateLimitConfigSchema } from '../lib/rateLimit.ts'
import type { RateLimitConfig } from '../lib/rateLimit.ts'
import type { KelpieModule } from '../runtime/module.ts'
import type { ModuleContributions } from '../runtime/registry.ts'
import type { EntitlementRegistry } from '../runtime/entitlements.ts'
import { registerModules } from '../runtime/registry.ts'
import { TEST_ENVIRONMENT } from './environment.ts'
import { createTestServices } from './services.ts'
import type { TestServices } from './services.ts'

/** The same defaults `loadConfig` produces from an empty environment: one source of numbers for both. */
const DEFAULT_TEST_RATE_LIMIT: RateLimitConfig = rateLimitConfigFrom(rateLimitConfigSchema.parse({}))

/**
 * A caller's IP, for tests. Real entry points resolve this from the socket
 * (`apps/kelpie/src/server.ts`); a test using `app.request()` has no socket, so
 * it reads `X-Forwarded-For` when a test sets one to simulate distinct
 * callers, falling back to a fixed address for everything else.
 */
function testClientIp(context: Context): string {
  return context.req.header('X-Forwarded-For') ?? '203.0.113.1'
}

/**
 * Assembles an app for tests. Unlike the real boot it defaults every dependency,
 * because a test that has to spell out an environment it does not care about
 * tests the harness instead of the code.
 */

export interface TestAppOptions {
  readonly modules?: readonly KelpieModule[]
  /** Defaults to `TEST_ENVIRONMENT`: enough for every core module to configure itself. */
  readonly environment?: Environment
  readonly probeDatabase?: () => Promise<DatabaseProbe>
  readonly generateRequestId?: () => string
  /** Defaults to fakes: a lazy unused database and a collecting email sender. */
  readonly services?: TestServices
  /** Inject one to grant or deny capabilities before core modules register. */
  readonly entitlements?: EntitlementRegistry
  /** A deploy-time module override, for a test exercising `runtime/moduleConfig.ts`. */
  readonly moduleConfig?: Readonly<Record<string, boolean>>
  /**
   * Resolves the actor a REST request carries, for a test exercising module
   * route gating. Omitted, as most tests want, gating is skipped and every
   * route behaves as it did before module toggling existed.
   */
  readonly resolveActor?: (context: Context) => Promise<Actor>
  /** Defaults to the same numbers `loadConfig` would, from an empty environment. */
  readonly rateLimit?: RateLimitConfig
  /** Defaults to reading `X-Forwarded-For`, so a test can simulate distinct callers. */
  readonly resolveClientIp?: (context: Context) => string
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
  const logger = createLogger({
    level: 'debug',
    transports: [createCaptureTransport((line) => logLines.push(line))],
  })

  const services = options.services ?? createTestServices()
  const contributions = await registerModules({
    modules: options.modules ?? [],
    environment: options.environment ?? TEST_ENVIRONMENT,
    logger,
    events: services.events,
    ...(options.entitlements === undefined ? {} : { entitlements: options.entitlements }),
    ...(options.moduleConfig === undefined ? {} : { moduleConfig: options.moduleConfig }),
    ...(options.resolveActor === undefined ? {} : { resolveActor: options.resolveActor }),
    services,
  })

  const app = createApp({
    logger,
    probeDatabase: options.probeDatabase ?? reachableDatabase,
    contributions,
    credentials: { db: services.db, now: services.now },
    generateRequestId: options.generateRequestId ?? (() => 'req-test'),
    createId: services.createId,
    rateLimit: options.rateLimit ?? DEFAULT_TEST_RATE_LIMIT,
    resolveClientIp: options.resolveClientIp ?? testClientIp,
  })

  return { app, contributions, logLines, services }
}
