import { index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { createdAt, moment, primaryId } from '../../lib/columns.ts'

/**
 * Fixed-window counters backing the rate limiter (`app.ts`). Not
 * workspace-owned, unlike every other core table: a public form submission or
 * an unauthenticated auth attempt has no workspace to scope to, which is
 * exactly the traffic this table exists to police. `scope` names the budget
 * (`forms`, `auth`, `api`) and `key` is the caller within it — an IP address
 * or an API key id.
 *
 * `(scope, key, window_start)` is unique rather than `(scope, key)` alone
 * because the window boundary lives in the key: a new window is a new row, so
 * incrementing is one atomic upsert (`repository.ts`) with no read before the
 * write to race against. A row is left for `pruneExpiredRateLimitBuckets` to
 * sweep once its window has elapsed rather than deleted eagerly, since nothing
 * reads a bucket after that.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    id: primaryId(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    windowStart: moment('window_start').notNull(),
    count: integer('count').notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    unique('rate_limit_buckets_scope_key_window_key').on(table.scope, table.key, table.windowStart),
    index('rate_limit_buckets_window_start_idx').on(table.windowStart),
  ],
)
