import { Hono } from 'hono'
import { cors } from 'hono/cors'

import type { DatabaseProbe } from './lib/database.ts'
import { AppError, internalErrorBody, toErrorBody } from './lib/errors.ts'
import { PUBLIC_ROUTE_PREFIX } from './lib/http.ts'
import { createIdFactory } from './lib/ids.ts'
import type { IdFactory } from './lib/ids.ts'
import type { Logger } from './lib/logger.ts'
import type { CredentialDependencies } from './modules/auth/credentials.ts'
import { MCP_INSTRUCTIONS, MCP_ROUTE_PREFIX, MCP_SERVER_INFO } from './modules/mcp/index.ts'
import { createMcpEndpoint } from './modules/mcp/router.ts'
import { createIdempotencyMiddleware } from './modules/workspace/idempotencyMiddleware.ts'
import type { ModuleContributions } from './runtime/registry.ts'

/**
 * Builds the HTTP application. Everything it touches arrives as a dependency, so
 * the app can be exercised without a database or a listening socket.
 */

export interface AppDependencies {
  readonly logger: Logger
  readonly probeDatabase: () => Promise<DatabaseProbe>
  /** Produced by the registration pass. Routers mount under `/v1`. */
  readonly contributions: ModuleContributions
  /**
   * What `/mcp` checks a bearer key against. The REST routes resolve their own
   * actor inside each module; the MCP endpoint is mounted here rather than by a
   * module, because its tools come from every module and the last of those has to
   * have registered before the listing exists.
   */
  readonly credentials: CredentialDependencies
  /** Injected so tests can pin the id echoed on responses. */
  readonly generateRequestId?: () => string
  /** Injected so tests can pin the ids `idempotencyMiddleware` reserves rows under. */
  readonly createId?: IdFactory
}

/** Per-request values the middleware chain sets and handlers read. */
export interface AppBindings {
  Variables: {
    requestId: string
    logger: Logger
  }
}

const REQUEST_ID_HEADER = 'X-Request-Id'

/**
 * Any origin, because a public endpoint exists to be called from a customer's
 * own website and Kelpie does not know that site's address.
 *
 * `credentials` stays off, which is what keeps this safe: a browser will not
 * attach the session cookie to these requests, so an embedded form on an
 * attacker's page cannot borrow a signed-in reader's identity. A public handler
 * has no `Actor` in any case (`runtime/module.ts`).
 */
const PUBLIC_CORS = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  credentials: false,
  maxAge: 86_400,
})

export function createApp(dependencies: AppDependencies): Hono<AppBindings> {
  const generateRequestId = dependencies.generateRequestId ?? (() => crypto.randomUUID())
  const createId = dependencies.createId ?? createIdFactory()
  const app = new Hono<AppBindings>()

  app.use('*', async (context, next) => {
    const requestId = context.req.header(REQUEST_ID_HEADER) ?? generateRequestId()
    const logger = dependencies.logger.child({ requestId })

    context.set('requestId', requestId)
    context.set('logger', logger)
    context.header(REQUEST_ID_HEADER, requestId)

    const startedAt = performance.now()
    await next()

    logger.info('request', {
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    })
  })

  // Every module's `POST` gets this the same way, decided once here rather than
  // per route (`api.md`). It skips `/v1/public/*` itself — a public request has
  // no `Actor` to scope a key to — so it is mounted ahead of the public CORS
  // middleware without conflicting with it.
  app.use(
    '/v1/*',
    createIdempotencyMiddleware({
      db: dependencies.credentials.db,
      now: dependencies.credentials.now,
      createId,
      credentials: dependencies.credentials,
      log: dependencies.logger,
    }),
  )

  // Public first. `/v1/public/...` cannot collide with a `/v1` route unless a
  // module names a resource `public`, and mounting in this order means the CORS
  // middleware is attached before anything can answer under the prefix.
  app.use(`${PUBLIC_ROUTE_PREFIX}/*`, PUBLIC_CORS)

  for (const { router } of dependencies.contributions.publicRouters) {
    app.route(PUBLIC_ROUTE_PREFIX, router)
  }

  for (const { router } of dependencies.contributions.routers) {
    app.route('/v1', router)
  }

  const mcp = createMcpEndpoint({
    ...dependencies.credentials,
    tools: dependencies.contributions.mcpTools,
    serverInfo: MCP_SERVER_INFO,
    instructions: MCP_INSTRUCTIONS,
    logger: dependencies.logger,
  })

  app.route(MCP_ROUTE_PREFIX, mcp.transport)
  app.route('/v1', mcp.catalog)

  app.onError((error, context) => {
    if (error instanceof AppError) {
      return context.json(toErrorBody(error), error.status)
    }

    context.get('logger').error('unhandled error', {
      method: context.req.method,
      path: context.req.path,
      error: error.message,
      stack: error.stack,
    })
    return context.json(internalErrorBody(), 500)
  })

  app.notFound((context) => context.json(toErrorBody(AppError.notFound()), 404))

  app.get('/healthz', async (context) => {
    const probe = await dependencies.probeDatabase()

    if (!probe.reachable) {
      context.get('logger').error('database unreachable', { reason: probe.reason })
      return context.json({ status: 'degraded', database: 'down' }, 503)
    }

    return context.json({ status: 'ok', database: 'up' }, 200)
  })

  return app
}
