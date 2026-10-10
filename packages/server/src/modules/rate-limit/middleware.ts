import type { Context, MiddlewareHandler } from 'hono'

import { bearerCredentialId, isBearerActor } from '../../lib/actor.ts'
import type { Actor } from '../../lib/actor.ts'
import { rateLimitKeyForIp } from '../../lib/clientIp.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { MAX_SHORT_TEXT_LENGTH } from '../../lib/fieldLimits.ts'
import { PUBLIC_ROUTE_PREFIX, setClientRateKey } from '../../lib/http.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { RateLimitBudget, RateLimitConfig } from '../../lib/rateLimit.ts'
import { readBearerToken } from '../api-keys/keys.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { findUserById } from '../auth/repository.ts'
import { incrementRateLimitBucket, pruneExpiredRateLimitBuckets } from './repository.ts'

/**
 * The budgets for `/v1`: public form routes, unauthenticated auth endpoints,
 * attempts aimed at one account, and everything else called with an API key.
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
 * attempt credential stuffing or enumerate accounts. `/auth/logout`, `/me` and
 * `/sessions` require a session already and carry no such risk, so they are
 * not here. The routes that check a current password, and the one that sends
 * the verification mail again, also require a session. They are counted per
 * account (`CURRENT_PASSWORD_PATHS`, `VERIFY_EMAIL_RESEND_PATH`).
 */
const UNAUTHENTICATED_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/password-reset',
  '/v1/auth/password-reset/confirm',
  '/v1/auth/verify-email/confirm',
])

/** Carries one more budget, for the account the request names. */
const LOGIN_PATH = '/v1/auth/login'

/** Carries one more budget, for the address the request asks to mail. */
const PASSWORD_RESET_PATH = '/v1/auth/password-reset'

/**
 * The `PATCH` routes that check the caller's current password. A session is
 * not proof of the password: somebody holding a stolen session cookie could
 * otherwise try values here without limit, and a correct guess lets them take
 * the account over.
 */
const CURRENT_PASSWORD_PATHS: ReadonlySet<string> = new Set(['/v1/auth/password', '/v1/account'])

/**
 * Sends the verification mail again. It needs a session, but anybody can get
 * one: sign up with another person's address, and each call here mails that
 * person.
 */
const VERIFY_EMAIL_RESEND_PATH = '/v1/auth/verify-email'

/**
 * The scope a public form route is counted under, or undefined for a path that
 * carries no budget.
 *
 * The submit `POST` and the embed `GET` share one counter. The token `GET` has
 * its own counter under the same budget: the embed page asks for a token on
 * every load, and that must not take from what a visitor has left to submit.
 * All three do database work for an unauthenticated caller.
 */
function formRouteScope(context: Context): 'forms' | 'forms-token' | undefined {
  const path = context.req.path

  if (context.req.method === 'POST' && path.endsWith('/submit')) {
    return 'forms'
  }

  if (context.req.method !== 'GET') {
    return undefined
  }

  if (path.endsWith('/embed')) {
    return 'forms'
  }

  return path.endsWith('/token') ? 'forms-token' : undefined
}

/** The caller's address as the limiter counts it: an IPv6 client by its `/64`. */
function clientKey(dependencies: RateLimitMiddlewareDependencies, context: Context): string {
  return rateLimitKeyForIp(dependencies.resolveClientIp(context))
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
    config.oauth.windowMs,
  )
}

/**
 * One string field of a JSON body, or undefined when the body does not carry
 * it as a string.
 *
 * Reads the body through Hono's cache, so the handler's own read of it later
 * is unaffected. A malformed body resolves to undefined here and is left for
 * the handler to reject.
 */
async function readBodyString(context: Context, field: string): Promise<string | undefined> {
  const body: unknown = await context.req.json().catch(() => undefined)

  if (typeof body !== 'object' || body === null) {
    return undefined
  }

  const value = (body as Record<string, unknown>)[field]

  return typeof value === 'string' ? value : undefined
}

/**
 * The email a login or reset request names, normalised the way the auth
 * service normalises it (`modules/auth/service.ts`), or undefined when the
 * body carries no usable one.
 *
 * An address longer than the handlers accept is not usable. The handler
 * refuses it with `422`, and it is too long for the index on the bucket key.
 */
async function readAccountEmail(context: Context): Promise<string | undefined> {
  const email = await readBodyString(context, 'email')

  if (email === undefined || email.length > MAX_SHORT_TEXT_LENGTH) {
    return undefined
  }

  const normalised = email.trim().toLowerCase()

  return normalised.length === 0 ? undefined : normalised
}

/**
 * The actor behind the request's credential, or undefined when it carries no
 * live one. The handler answers that `401` itself, and on `/mcp` its answer
 * carries the `WWW-Authenticate` challenge a client needs; refusing here would
 * drop it.
 */
async function resolveLiveActor(
  dependencies: RateLimitMiddlewareDependencies,
  context: Context,
): Promise<Actor | undefined> {
  return resolveActorFrom(dependencies.credentials, context).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'unauthorized') {
      return undefined
    }

    throw error
  })
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
  params: {
    readonly scope: string
    readonly key: string
    readonly budget: RateLimitBudget
    readonly amount?: number
  },
): Promise<void> {
  const amount = params.amount ?? 1
  const now = dependencies.now()
  const start = windowStart(now, params.budget.windowMs)

  const count = await incrementRateLimitBucket(dependencies.db, {
    id: dependencies.createId('rateLimitBucket'),
    scope: params.scope,
    key: params.key,
    windowStart: start,
    amount,
  })

  // Equal to the amount means this request opened the window.
  if (count === amount) {
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
 * Counts one attempt at the current password against the account the session
 * belongs to, whatever session or address it comes from.
 *
 * Only a request that sends `current_password` is counted, so a profile edit
 * that needs no password spends nothing. The attempt is counted before the
 * handler checks it, not after a failure: many requests sent at once would
 * otherwise all be checked before any of them was counted.
 */
async function enforceCurrentPasswordBudget(
  dependencies: RateLimitMiddlewareDependencies,
  context: Context,
): Promise<void> {
  if ((await readBodyString(context, 'current_password')) === undefined) {
    return
  }

  const actor = await resolveLiveActor(dependencies, context)

  // Only a session can call these routes. The handler refuses every other
  // credential before it checks a password.
  if (actor === undefined || actor.kind !== 'session') {
    return
  }

  await enforceBudget(dependencies, context, {
    scope: 'current-password',
    key: actor.userId,
    budget: dependencies.config.loginAccount,
  })
}

/**
 * Counts one request for the verification mail, against the account and then
 * against the address the mail goes to.
 *
 * The account count follows the person across sessions and client addresses.
 * The address count is there because an account can change its address
 * (`PATCH /v1/account`): without it, several accounts could take turns on one
 * address and each spend a full account budget mailing it. A request the
 * account count refuses never reaches the address count.
 */
async function enforceVerificationMailBudget(
  dependencies: RateLimitMiddlewareDependencies,
  context: Context,
): Promise<void> {
  const actor = await resolveLiveActor(dependencies, context)

  // Only a session can call this route. The handler refuses every other credential.
  if (actor === undefined || actor.kind !== 'session') {
    return
  }

  await enforceBudget(dependencies, context, {
    scope: 'verify-email-account',
    key: actor.userId,
    budget: dependencies.config.loginAccount,
  })

  const user = await findUserById(dependencies.db, actor.userId)

  // A session whose account is gone mails nobody. The handler answers it.
  if (user === undefined) {
    return
  }

  await enforceBudget(dependencies, context, {
    scope: 'verify-email-address',
    key: user.email,
    budget: dependencies.config.loginAccount,
  })
}

/**
 * Spends more of a bearer credential's `api` budget than the one unit the
 * middleware took for the request.
 *
 * `/mcp` uses it for a batch: one POST there can carry many messages, and each
 * is a call the budget exists to count. Throws `429` when the credential is
 * over budget. A session spends nothing, as in the middleware.
 */
export type ApiBudgetCharger = (context: Context, actor: Actor, units: number) => Promise<void>

export function createApiBudgetCharger(dependencies: RateLimitMiddlewareDependencies): ApiBudgetCharger {
  return async (context, actor, units) => {
    if (units <= 0 || !isBearerActor(actor)) {
      return
    }

    await enforceBudget(dependencies, context, {
      scope: 'api',
      key: bearerCredentialId(actor),
      budget: dependencies.config.api,
      amount: units,
    })
  }
}

/**
 * Guards the public form routes that reach the database, keyed by the caller's
 * IP: the submit `POST`, the embed `GET` and the token `GET`.
 *
 * Mount this **after** `PUBLIC_CORS` in `app.ts`. Every other path under the
 * public prefix passes through untouched.
 */
export function createFormSubmitRateLimitMiddleware(
  dependencies: RateLimitMiddlewareDependencies,
): MiddlewareHandler {
  return async (context, next) => {
    const scope = formRouteScope(context)

    if (scope === undefined) {
      await next()
      return
    }

    const key = clientKey(dependencies, context)

    // The submit handler counts auto-replies for the same caller.
    setClientRateKey(context, key)

    await enforceBudget(dependencies, context, {
      scope,
      key,
      budget: dependencies.config.forms,
    })
    await next()
  }
}

/**
 * Guards the OAuth protocol endpoints, keyed by the caller's IP.
 *
 * They take no Kelpie credential: `/oauth/register` creates a client for
 * anyone, and `/oauth/token` is where a stolen code or refresh token would be
 * tried. The discovery documents under `/.well-known` are static and are not
 * metered. Its own budget rather than the `auth` one: a hosted client makes
 * every one of its users' token requests from a few shared addresses.
 */
export function createOAuthRateLimitMiddleware(
  dependencies: RateLimitMiddlewareDependencies,
): MiddlewareHandler {
  return async (context, next) => {
    await enforceBudget(dependencies, context, {
      scope: 'oauth',
      key: clientKey(dependencies, context),
      budget: dependencies.config.oauth,
    })
    await next()
  }
}

/**
 * Guards the unauthenticated auth endpoints (by IP) and every other `/v1/*`
 * request made with an API key (by that key) — the budget that protects a
 * workspace rather than the world. Session traffic, the product's own UI,
 * carries no budget here, except an attempt at the account's current password
 * and a request for the verification mail.
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
      const ipKey = clientKey(dependencies, context)

      await enforceBudget(dependencies, context, { scope: 'auth', key: ipKey, budget: dependencies.config.auth })

      if (path === LOGIN_PATH || path === PASSWORD_RESET_PATH) {
        const email = await readAccountEmail(context)

        // A second budget for login, keyed on the account rather than the IP, so a
        // distributed attack on one address is capped whatever IPs it comes from.
        if (email !== undefined && path === LOGIN_PATH) {
          await enforceBudget(dependencies, context, {
            scope: 'login-account',
            key: email,
            budget: dependencies.config.loginAccount,
          })
        }

        // Keyed on the address as typed, whatever IPs ask, so one mailbox
        // cannot be sent reset mail without limit. The count does not depend
        // on whether an account has the address, so the `429` tells a caller
        // nothing about that.
        if (email !== undefined && path === PASSWORD_RESET_PATH) {
          await enforceBudget(dependencies, context, {
            scope: 'password-reset-account',
            key: email,
            budget: dependencies.config.loginAccount,
          })
        }
      }

      await next()
      return
    }

    if (context.req.method === 'PATCH' && CURRENT_PASSWORD_PATHS.has(path)) {
      await enforceCurrentPasswordBudget(dependencies, context)
    }

    if (context.req.method === 'POST' && path === VERIFY_EMAIL_RESEND_PATH) {
      await enforceVerificationMailBudget(dependencies, context)
    }

    // Only a bearer credential can resolve to an API key or an OAuth grant,
    // the kinds this budget applies to, so a cookie-only request — the
    // ordinary browser session — never pays for an actor resolution here at all.
    const bearer = readBearerToken(context.req.header('Authorization'))

    if (bearer === undefined || bearer.length === 0) {
      await next()
      return
    }

    const actor = await resolveLiveActor(dependencies, context)

    if (actor === undefined || !isBearerActor(actor)) {
      await next()
      return
    }

    await enforceBudget(dependencies, context, {
      scope: 'api',
      key: bearerCredentialId(actor),
      budget: dependencies.config.api,
    })
    await next()
  }
}
