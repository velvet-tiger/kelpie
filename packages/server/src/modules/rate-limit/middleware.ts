import type { Context, MiddlewareHandler } from 'hono'

import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { PUBLIC_ROUTE_PREFIX } from '../../lib/http.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { RateLimitBudget, RateLimitConfig } from '../../lib/rateLimit.ts'
import { readBearerToken } from '../api-keys/keys.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { incrementRateLimitBucket, pruneExpiredRateLimitBuckets } from './repository.ts'

/**
 * The three budgets `api.md` describes for `/v1`: public form submissions,
 * unauthenticated auth endpoints, and everything else called with an API key.
 * Split into two middlewares rather than one, because the forms budget has to
 * sit *inside* `PUBLIC_CORS` in `app.ts` — a throw ahead of it would strip the
 * CORS headers a cross-origin embed needs to read the 429 body — while the
 * auth and API budgets have no CORS concern and can run earlier.
 */

export interface RateLimitMiddlewareDependencies {
  readonly db: Database
  readonly now: () => Date
  readonly createId: IdFactory
  readonly credentials: CredentialDependencies
  readonly resolveClientIp: (context: Context) => string
  readonly config: RateLimitConfig
}

/**
 * Every unauthenticated `/v1/auth/*` endpoint: the ones a stranger can call to
 * attempt credential stuffing or enumerate accounts. `/auth/logout`, `/me`,
 * `/sessions` and changing a known password all require a session already and
 * carry no such risk, so they are not here.
 */
const UNAUTHENTICATED_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/password-reset',
  '/v1/auth/password-reset/confirm',
])

function isFormSubmitRoute(context: Context): boolean {
  return context.req.method === 'POST' && context.req.path.endsWith('/submit')
}

/** Floors `now` to the start of its fixed window, so every caller in the same window shares one row. */
function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

/**
 * The largest configured window across all three budgets. A bucket cannot be
 * expired before its own window elapses, so this is a safe cutoff for
 * pruning regardless of which budget created the row.
 */
function maxWindowMs(config: RateLimitConfig): number {
  return Math.max(config.forms.windowMs, config.auth.windowMs, config.api.windowMs)
}

/**
 * Increments the bucket and throws `429` with `Retry-After` once the caller is
 * over budget. Pruning runs only when this request started a fresh window
 * (`count === 1`) rather than on every call, which ties cleanup frequency to
 * how often new windows open instead of to raw request volume.
 */
async function enforceBudget(
  dependencies: RateLimitMiddlewareDependencies,
  context: Context,
  params: { readonly scope: string; readonly key: string; readonly budget: RateLimitBudget },
): Promise<void> {
  const now = dependencies.now()
  const start = windowStart(now, params.budget.windowMs)

  const count = await incrementRateLimitBucket(dependencies.db, {
    id: dependencies.createId('rateLimitBucket'),
    scope: params.scope,
    key: params.key,
    windowStart: start,
  })

  if (count === 1) {
    await pruneExpiredRateLimitBuckets(dependencies.db, new Date(now.getTime() - maxWindowMs(dependencies.config)))
  }

  if (count > params.budget.limit) {
    const resetAt = start.getTime() + params.budget.windowMs
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000))

    context.header('Retry-After', String(retryAfterSeconds))
    throw AppError.rateLimited()
  }
}

/**
 * Guards `POST /v1/public/forms/:key/submit`, keyed by the caller's IP.
 *
 * Mount this **after** `PUBLIC_CORS` in `app.ts`. It only recognises the
 * submit route; every other path under the public prefix, including the embed
 * page itself, passes through untouched.
 */
export function createFormSubmitRateLimitMiddleware(
  dependencies: RateLimitMiddlewareDependencies,
): MiddlewareHandler {
  return async (context, next) => {
    if (!isFormSubmitRoute(context)) {
      await next()
      return
    }

    await enforceBudget(dependencies, context, {
      scope: 'forms',
      key: dependencies.resolveClientIp(context),
      budget: dependencies.config.forms,
    })
    await next()
  }
}

/**
 * Guards the unauthenticated auth endpoints (by IP) and every other `/v1/*`
 * request made with an API key (by that key) — the budget that protects a
 * workspace rather than the world. Session traffic, the product's own UI,
 * carries no budget here.
 *
 * Public routes are skipped: `createFormSubmitRateLimitMiddleware` already
 * covers them, positioned where `PUBLIC_CORS` requires. Mount this one
 * anywhere else on `/v1/*`, ahead of idempotency so a rate-limited request
 * never reserves an idempotency key it will not be allowed to spend.
 */
export function createAuthAndApiRateLimitMiddleware(
  dependencies: RateLimitMiddlewareDependencies,
): MiddlewareHandler {
  return async (context, next) => {
    const path = context.req.path

    if (path === PUBLIC_ROUTE_PREFIX || path.startsWith(`${PUBLIC_ROUTE_PREFIX}/`)) {
      await next()
      return
    }

    if (context.req.method === 'POST' && UNAUTHENTICATED_AUTH_PATHS.has(path)) {
      await enforceBudget(dependencies, context, {
        scope: 'auth',
        key: dependencies.resolveClientIp(context),
        budget: dependencies.config.auth,
      })
      await next()
      return
    }

    // Only a bearer credential can resolve to an `api_key` actor, the only
    // kind this budget applies to, so a cookie-only request — the ordinary
    // browser session — never pays for an actor resolution here at all.
    const bearer = readBearerToken(context.req.header('Authorization'))

    if (bearer === undefined || bearer.length === 0) {
      await next()
      return
    }

    const actor = await resolveActorFrom(dependencies.credentials, context)

    if (actor.kind !== 'api_key') {
      await next()
      return
    }

    await enforceBudget(dependencies, context, {
      scope: 'api',
      key: actor.apiKeyId,
      budget: dependencies.config.api,
    })
    await next()
  }
}
