import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

import type { RuntimeMode } from './lib/config.ts'
import type { DatabaseProbe } from './lib/database.ts'
import { AppError, internalErrorBody, toErrorBody } from './lib/errors.ts'
import { PUBLIC_ROUTE_PREFIX } from './lib/http.ts'
import { createIdFactory } from './lib/ids.ts'
import type { IdFactory } from './lib/ids.ts'
import type { Logger } from './lib/logger.ts'
import type { RateLimitConfig } from './lib/rateLimit.ts'
import { securityHeadersMiddleware } from './lib/securityHeaders.ts'
import type { CredentialDependencies } from './modules/auth/credentials.ts'
import { MCP_INSTRUCTIONS, MCP_ROUTE_PREFIX, MCP_SERVER_INFO } from './modules/mcp/index.ts'
import { createMcpEndpoint } from './modules/mcp/router.ts'
import { createApiKeyScopeMiddleware } from './modules/api-keys/scopeMiddleware.ts'
import {
  createAuthAndApiRateLimitMiddleware,
  createFormSubmitRateLimitMiddleware,
} from './modules/rate-limit/middleware.ts'
import { createIdempotencyMiddleware } from './modules/workspace/idempotencyMiddleware.ts'
import { createWorkspaceAccessMiddleware } from './modules/workspace/workspaceAccessMiddleware.ts'
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
  readonly rateLimit: RateLimitConfig
  /**
   * Required rather than defaulted: a wrong-but-plausible fallback (trusting a
   * spoofable header, say) would degrade the rate limiter silently instead of
   * failing to build. The real entry points resolve this from the actual
   * socket (`apps/kelpie/src/server.ts`); tests resolve it from a header they
   * control (`testing/app.ts`).
   */
  readonly resolveClientIp: (context: Context) => string
  /**
   * Reported through `GET /v1/public/config` so the browser knows which
   * runtime it is talking to. Defaults to `'production'` so a caller that has
   * not thought about it fails safe: no banner shows.
   */
  readonly runtimeMode?: RuntimeMode
  /**
   * Reported through `GET /v1/public/config` so a non-production UI can name
   * the site it is on. Undefined is fine and means "this deployment did not
   * name itself".
   */
  readonly siteName?: string | undefined
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

  app.use('*', securityHeadersMiddleware)

  const rateLimitDependencies = {
    db: dependencies.credentials.db,
    now: dependencies.credentials.now,
    createId,
    credentials: dependencies.credentials,
    resolveClientIp: dependencies.resolveClientIp,
    config: dependencies.rateLimit,
  }

  // Ahead of idempotency, so a rate-limited request never reserves an
  // idempotency key it will not be allowed to spend. Skips `/v1/public/*`
  // itself; `createFormSubmitRateLimitMiddleware` below covers it, mounted
  // where the public CORS middleware requires.
  app.use('/v1/*', createAuthAndApiRateLimitMiddleware(rateLimitDependencies))

  // Ahead of idempotency too, for the same reason: a request this blocks
  // must never reserve a key it will not be allowed to spend. Inert without
  // a module granting or denying `workspace.access` (`capabilities.ts`).
  const workspaceAccessMiddleware = createWorkspaceAccessMiddleware({
    db: dependencies.credentials.db,
    now: dependencies.credentials.now,
    entitlements: dependencies.contributions.entitlements,
  })

  app.use('/v1/*', workspaceAccessMiddleware)

  app.use('/v1/*', createApiKeyScopeMiddleware(dependencies.credentials))

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

  // After CORS, not before: a throw ahead of it would strip the CORS headers a
  // cross-origin embed needs to read the 429 body, and would apply to the
  // preflight `OPTIONS` request CORS itself answers without reaching here.
  app.use(`${PUBLIC_ROUTE_PREFIX}/*`, createFormSubmitRateLimitMiddleware(rateLimitDependencies))

  for (const { router } of dependencies.contributions.publicRouters) {
    app.route(PUBLIC_ROUTE_PREFIX, router)
  }

  // Public deployment metadata the browser reads once at boot. Sits under the
  // public prefix so the CORS and rate-limit layers above cover it, and takes
  // no credentials for the same reason /healthz does not: the pages that read
  // it include the sign-in page, which runs before any session exists. The
  // runtime mode is already visible in error messages, and the site name
  // exists to be visible; nothing here is sensitive.
  const runtimeMode: RuntimeMode = dependencies.runtimeMode ?? 'production'
  const siteName = dependencies.siteName ?? null

  app.get(`${PUBLIC_ROUTE_PREFIX}/config`, (context) =>
    context.json({ runtime_mode: runtimeMode, site_name: siteName }, 200),
  )

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

  // The transport takes bearer keys only (`api.md`), so every call that
  // reaches it is already the `api_key` traffic the `api` budget above
  // exists for. Shared with `/v1` rather than a separate budget: one key's
  // usage is one thing to protect the workspace from, whichever surface it
  // comes through. No CORS layer to mind the order of here, unlike the forms
  // budget — the transport checks its own `Origin` inside the handler.
  app.use(MCP_ROUTE_PREFIX, createAuthAndApiRateLimitMiddleware(rateLimitDependencies))

  // MCP mirrors `/v1` one-to-one, so a workspace this gate blocks must not
  // still be reachable through agent tools.
  app.use(MCP_ROUTE_PREFIX, workspaceAccessMiddleware)

  app.route(MCP_ROUTE_PREFIX, mcp.transport)
  app.route('/v1', mcp.catalog)

  // Module declarations on the app itself, outside /v1 (`runtime/module.ts`).
  // Middleware first, all of it, then routes: within one request Hono
  // composes matching handlers in registration order, so this is what makes
  // a declared pattern cover matching routes from every module, whichever
  // registered first. Registered after core's own surfaces above, so nothing
  // here can run ahead of them. Not rate limited: the `/v1` budgets are
  // per-workspace-credential, and a declared surface owns its own access
  // rules.
  for (const middleware of dependencies.contributions.appMiddleware) {
    app.use(middleware.pattern, middleware.handler)
  }

  for (const route of dependencies.contributions.appRoutes) {
    app.on(route.method, route.path, route.handler)
  }

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
