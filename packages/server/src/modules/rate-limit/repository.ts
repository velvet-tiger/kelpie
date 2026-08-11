import { lt, sql } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { rateLimitBuckets } from './schema.ts'

/** Queries for `rate_limit_buckets`. The middleware decides; these read and write. */

export type Queryable = Database | Transaction

export type RateLimitBucketRecord = typeof rateLimitBuckets.$inferSelect

/**
 * Increments the counter for `(scope, key, windowStart)`, creating the row on
 * the first request of a window.
 *
 * One atomic upsert. Postgres's own row lock under `ON CONFLICT` is what makes
 * concurrent requests from the same caller count correctly with no read
 * followed by a separate write to race against — the same shape
 * `reserveIdempotencyKey` uses, and for the same reason: two statements can't
 * be made atomic against each other, but one can.
 */
export async function incrementRateLimitBucket(
  db: Queryable,
  params: { readonly id: string; readonly scope: string; readonly key: string; readonly windowStart: Date },
): Promise<number> {
  const [row] = await db
    .insert(rateLimitBuckets)
    .values({
      id: params.id,
      scope: params.scope,
      key: params.key,
      windowStart: params.windowStart,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.scope, rateLimitBuckets.key, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count })

  if (row === undefined) {
    throw new Error('rate limit bucket upsert returned no row')
  }

  return row.count
}

/**
 * Sweeps buckets from windows that have fully elapsed.
 *
 * Enforced here rather than by a schedule, the same call `idempotency_keys`
 * and `webhook_deliveries` make about their own growth: there is no scheduler
 * in the service, so the middleware prunes on every increment
 * (`middleware.ts`) and the table stays bounded by the traffic that grows it.
 */
export async function pruneExpiredRateLimitBuckets(db: Queryable, before: Date): Promise<number> {
  const deleted = await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.windowStart, before))
    .returning({ id: rateLimitBuckets.id })

  return deleted.length
}
