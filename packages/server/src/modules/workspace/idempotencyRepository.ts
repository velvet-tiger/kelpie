import { and, eq, lt } from 'drizzle-orm'

import { idempotencyKeys } from './schema.ts'
import type { StoredIdempotentResponse } from './schema.ts'
import type { Queryable } from './repository.ts'

/** Queries for `idempotency_keys`. The middleware decides; these read and write. */

export type IdempotencyKeyRecord = typeof idempotencyKeys.$inferSelect

/**
 * Reserves a key, or reclaims one whose reservation has expired.
 *
 * A plain insert would raise a unique violation on a second request for the
 * same `(workspace_id, key)`, which is exactly the signal the caller needs —
 * but Postgres has no way to say "insert, unless the existing row is expired,
 * in which case overwrite it" as two statements without a race between them.
 * `onConflictDoUpdate` with a `setWhere` does it as one: the update only fires
 * when the existing row's `expires_at` is already past, and `returning()` is
 * empty exactly when neither the insert nor the update happened, which is the
 * caller's signal to go read the live row instead.
 */
export async function reserveIdempotencyKey(
  db: Queryable,
  params: {
    readonly id: string
    readonly workspaceId: string
    readonly key: string
    readonly requestHash: string
    readonly expiresAt: Date
    readonly now: Date
  },
): Promise<IdempotencyKeyRecord | undefined> {
  const [reserved] = await db
    .insert(idempotencyKeys)
    .values({
      id: params.id,
      workspaceId: params.workspaceId,
      key: params.key,
      requestHash: params.requestHash,
      response: null,
      expiresAt: params.expiresAt,
      createdAt: params.now,
    })
    .onConflictDoUpdate({
      target: [idempotencyKeys.workspaceId, idempotencyKeys.key],
      set: {
        id: params.id,
        requestHash: params.requestHash,
        response: null,
        expiresAt: params.expiresAt,
        createdAt: params.now,
      },
      setWhere: lt(idempotencyKeys.expiresAt, params.now),
    })
    .returning()

  return reserved
}

/** The live row for a key, whether its reservation is still in flight or answered. */
export async function findIdempotencyKey(
  db: Queryable,
  workspaceId: string,
  key: string,
): Promise<IdempotencyKeyRecord | undefined> {
  const [found] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.workspaceId, workspaceId), eq(idempotencyKeys.key, key)))
    .limit(1)

  return found
}

/** Fills in the reservation once the handler has answered. */
export async function completeIdempotencyKey(
  db: Queryable,
  id: string,
  response: StoredIdempotentResponse,
): Promise<void> {
  await db.update(idempotencyKeys).set({ response }).where(eq(idempotencyKeys.id, id))
}

/** Frees a reservation the handler failed to fill, so a retry is not blocked by it. */
export async function deleteIdempotencyKey(db: Queryable, id: string): Promise<void> {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id))
}

/**
 * Clears this workspace's other expired keys.
 *
 * Enforced here rather than by a schedule, the same call as
 * `webhooks/delivery.ts` makes about its delivery log: there is no scheduler in
 * the service, and the table only grows through a reservation, so pruning on
 * every reservation caps it where the growth happens. The residue is the same
 * kind too — a key nobody replays keeps its row until the next reservation in
 * that workspace sweeps it.
 */
export async function pruneExpiredIdempotencyKeys(
  db: Queryable,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.workspaceId, workspaceId), lt(idempotencyKeys.expiresAt, now)))
    .returning({ id: idempotencyKeys.id })

  return deleted.length
}
