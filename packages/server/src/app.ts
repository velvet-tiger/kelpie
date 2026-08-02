import { Hono } from 'hono'

import type { DatabaseProbe } from './lib/database.ts'
import { AppError, internalErrorBody, toErrorBody } from './lib/errors.ts'
import type { Logger } from './lib/logger.ts'
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
  /** Injected so tests can pin the id echoed on responses. */
  readonly generateRequestId?: () => string
}

/** Per-request values the middleware chain sets and handlers read. */
export interface AppBindings {
  Variables: {
    requestId: string
    logger: Logger
  }
}

const REQUEST_ID_HEADER = 'X-Request-Id'

export function createApp(dependencies: AppDependencies): Hono<AppBindings> {
  const generateRequestId = dependencies.generateRequestId ?? (() => crypto.randomUUID())
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

  for (const { router } of dependencies.contributions.routers) {
    app.route('/v1', router)
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
