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
  '/v1/auth/verify-email/confirm',
])

/** The one path in the set that also carries a per-account budget. */
const LOGIN_PATH = '/v1/auth/login'

/**
 * The public form routes that carry the forms budget: the submit POST and the
 * embed GET. Both do database work for an unauthenticated caller, so both are
 * metered by IP. Every other path under the public prefix passes through.
 */
function isMeteredFormRoute(context: Context): boolean {
  const path = context.req.path

  if (context.req.method === 'POST' && path.endsWith('/submit')) {
    return true
  }

  return context.req.method === 'GET' && path.endsWith('/embed')
}

/** Floors `now` to the start of its fixed window, so every caller in the same window shares one row. */
function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

/**
 * The largest configured window across every budget. A bucket cannot be expired
 * before its own window elapses, so this is a safe cutoff for pruning regardless
 * of which budget created the row. The `login-account` window is the longest by
 * default, so leaving it out would prune a live account bucket early.
 */
function maxWindowMs(config: RateLimitConfig): number {
  return Math.max(
    config.forms.windowMs,
    config.auth.windowMs,
    config.loginAccount.windowMs,
    config.api.windowMs,
  )
}

/**
 * The email a login request names, normalised the way the auth service
 * normalises it (`modules/auth/service.ts`), or undefined when the body carries
 * no usable one.
 *
 * Reads the body through Hono's cache, so the login handler's own read of it
 * later is unaffected. A malformed body resolves to undefined here and is left
 * for the handler to reject.
 */
async function readLoginEmail(context: Context): Promise<string | undefined> {
  const body: unknown = await context.req.json().catch(() => undefined)

  if (typeof body !== 'object' || body === null) {
    return undefined
  }

  const email = (body as Record<string, unknown>).email

  if (typeof email !== 'string') {
    return undefined
  }

  const normalised = email.trim().toLowerCase()

  return normalised.length === 0 ? undefined : normalised
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
 * Guards the public form routes that reach the database, keyed by the caller's
 * IP: the submit `POST` and the embed `GET`.
 *
 * Mount this **after** `PUBLIC_CORS` in `app.ts`. Every other path under the
 * public prefix passes through untouched.
 */
export function createFormSubmitRateLimitMiddleware(
  dependencies: RateLimitMiddlewareDependencies,
): MiddlewareHandler {
  return async (context, next) => {
    if (!isMeteredFormRoute(context)) {
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

      // A second budget for login, keyed on the account rather than the IP, so a
      // distributed attack on one address is capped whatever IPs it comes from.
      if (path === LOGIN_PATH) {
        const email = await readLoginEmail(context)

        if (email !== undefined) {
          await enforceBudget(dependencies, context, {
            scope: 'login-account',
            key: email,
            budget: dependencies.config.loginAccount,
          })
        }
      }

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
