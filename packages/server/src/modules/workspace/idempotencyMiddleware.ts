import { createHash } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'

import type { Database } from '../../lib/database.ts'
import { AppError, describeThrown } from '../../lib/errors.ts'
import { PUBLIC_ROUTE_PREFIX } from '../../lib/http.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { Logger } from '../../lib/logger.ts'
import { actorWorkspaceId } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import {
  completeIdempotencyKey,
  deleteIdempotencyKey,
  findIdempotencyKey,
  pruneExpiredIdempotencyKeys,
  reserveIdempotencyKey,
} from './idempotencyRepository.ts'
import type { IdempotencyKeyRecord } from './idempotencyRepository.ts'
import type { StoredIdempotentResponse } from './schema.ts'

/**
 * `POST /v1/*` accepts an optional `Idempotency-Key` header (`api.md`). Applied
 * once here rather than per route, because every module's `POST` gets the same
 * behaviour and none of them decide it individually.
 */

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'

/** `api.md`: a replayed key returns the original response within this window. */
export const IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000

export interface IdempotencyMiddlewareDependencies {
  readonly db: Database
  readonly now: () => Date
  readonly createId: IdFactory
  readonly credentials: CredentialDependencies
  readonly log: Logger
}

/** Method, path, and raw body, so a byte-for-byte different request never replays. */
function hashRequest(method: string, path: string, rawBody: string): string {
  return createHash('sha256').update(method).update('\n').update(path).update('\n').update(rawBody).digest('hex')
}

function isPublicRoute(path: string): boolean {
  return path === PUBLIC_ROUTE_PREFIX || path.startsWith(`${PUBLIC_ROUTE_PREFIX}/`)
}

/**
 * Builds the replayed `Response` directly rather than through `c.json()`: the
 * stored status is a `number` read back from the database, not one of the
 * literal `ContentfulStatusCode`s `c.json()`'s type expects, and there is
 * nothing to narrow it to at this point.
 */
function replayResponse(stored: StoredIdempotentResponse): Response {
  return new Response(JSON.stringify(stored.body), {
    status: stored.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function conflict(message: string): AppError {
  return AppError.conflict(message, [{ field: 'Idempotency-Key', message }])
}

/**
 * Whether `acquireReservation` won the row, found somebody else's live one, or
 * lost a race entirely. Kept as a tag rather than inferred from the record's
 * fields afterwards: a concurrent retry of the identical request can leave a
 * row with a matching hash and a null response that we did *not* reserve, and
 * that case has to be refused (409, still in flight) rather than run — so
 * which branch produced the record is the only thing that can decide it.
 */
type ReservationOutcome =
  | { readonly kind: 'reserved'; readonly record: IdempotencyKeyRecord }
  | { readonly kind: 'existing'; readonly record: IdempotencyKeyRecord }
  | { readonly kind: 'contended' }

/**
 * Reserves the key, retrying once if the row we read after a failed reserve
 * has since disappeared — the concurrent request holding it failed and freed
 * it between our attempts. A second miss means another request just took it;
 * treated the same as any other in-flight conflict rather than retried again,
 * so a pathological case cannot loop.
 */
async function acquireReservation(
  dependencies: IdempotencyMiddlewareDependencies,
  params: { readonly workspaceId: string; readonly key: string; readonly requestHash: string; readonly now: Date },
): Promise<ReservationOutcome> {
  const expiresAt = new Date(params.now.getTime() + IDEMPOTENCY_REPLAY_WINDOW_MS)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reserved = await reserveIdempotencyKey(dependencies.db, {
      id: dependencies.createId('idempotencyKey'),
      workspaceId: params.workspaceId,
      key: params.key,
      requestHash: params.requestHash,
      expiresAt,
      now: params.now,
    })

    if (reserved !== undefined) {
      return { kind: 'reserved', record: reserved }
    }

    const existing = await findIdempotencyKey(dependencies.db, params.workspaceId, params.key)

    if (existing !== undefined) {
      return { kind: 'existing', record: existing }
    }
  }

  return { kind: 'contended' }
}

export function createIdempotencyMiddleware(dependencies: IdempotencyMiddlewareDependencies): MiddlewareHandler {
  return async (context: Context, next) => {
    if (context.req.method !== 'POST' || isPublicRoute(context.req.path)) {
      await next()
      return
    }

    const key = context.req.header(IDEMPOTENCY_KEY_HEADER)

    if (key === undefined || key.length === 0) {
      await next()
      return
    }

    const actor = await resolveActorFrom(dependencies.credentials, context).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'unauthorized') {
        // No credential to scope a key to. The unauthenticated auth endpoints
        // (`POST /v1/auth/login`, `/signup`, the reset pair) are the case: they
        // must answer without a credential, so a key on one of them cannot 401
        // here. They handle their own auth; idempotency does not apply.
        return undefined
      }

      throw error
    })

    if (actor === undefined) {
      await next()
      return
    }

    const workspaceId = actorWorkspaceId(actor)

    // Between signup and a first workspace (`POST /v1/workspaces`, `POST
    // /v1/invites/accept`) there is nothing to scope a key to. The request
    // runs unguarded rather than refusing a legitimate onboarding call.
    if (workspaceId === null) {
      await next()
      return
    }

    const rawBody = await context.req.text()
    const requestHash = hashRequest(context.req.method, context.req.path, rawBody)
    const now = dependencies.now()

    const outcome = await acquireReservation(dependencies, { workspaceId, key, requestHash, now })

    if (outcome.kind === 'contended') {
      throw conflict('A request with this Idempotency-Key is already in progress')
    }

    if (outcome.kind === 'existing') {
      if (outcome.record.response === null) {
        throw conflict('A request with this Idempotency-Key is already in progress')
      }

      if (outcome.record.requestHash !== requestHash) {
        throw conflict('This Idempotency-Key was already used for a different request')
      }

      return replayResponse(outcome.record.response)
    }

    const record = outcome.record

    // `app.onError` (`app.ts`) catches a thrown `AppError` at the dispatch frame
    // closest to where it was thrown, inside Hono's own `compose`, and resolves
    // `next()` there rather than rejecting it back up through this middleware.
    // So "the handler threw" and "the handler answered" are indistinguishable
    // from here by whether `next()` rejects — both leave `context.res` set. The
    // `try`/`catch` below only ever fires for something `onError` itself could
    // not handle (a non-`Error` throw); the real failure signal is the status.
    try {
      await next()
    } catch (error) {
      await deleteIdempotencyKey(dependencies.db, record.id)
      throw error
    }

    if (context.res.status >= 400) {
      // Not replayed: a retry of this key should run again, not repeat the
      // failure. Deleting rather than storing it is what makes that happen.
      await deleteIdempotencyKey(dependencies.db, record.id)
      return undefined
    }

    try {
      const bodyText = await context.res.clone().text()
      const body: unknown = bodyText.length === 0 ? null : JSON.parse(bodyText)

      await completeIdempotencyKey(dependencies.db, record.id, { status: context.res.status, body })
      await pruneExpiredIdempotencyKeys(dependencies.db, workspaceId, now)
    } catch (persistError) {
      // The handler already answered correctly; a bookkeeping failure here must
      // not turn that answer into a 500. The reservation is left in flight and
      // simply expires, so the worst case is a future replay of this key being
      // refused as in-progress rather than replayed, never a duplicate write.
      dependencies.log.warn('failed to persist idempotency key response', {
        workspaceId,
        key,
        error: describeThrown(persistError),
      })
    }

    return undefined
  }
}
