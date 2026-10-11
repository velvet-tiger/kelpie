import { sql } from 'drizzle-orm'

import type { Database } from '../lib/database.ts'

/**
 * How many sessions on this database are waiting for a row lock right now.
 *
 * A test that needs one statement to land between another's read and its
 * write holds a row lock in an open transaction, starts the code under test,
 * and commits once this reports a waiter. The order of events is then the
 * database's and not a guess about timing.
 *
 * Counts row waits only. A session that waits for a row another transaction
 * has locked shows `transactionid`, and one that queues behind such a waiter
 * shows `tuple`. Any other lock wait is not this test's: a job worker in the
 * same database can wait on an advisory lock, and counting it would let the
 * test commit before the code under test has reached the row.
 *
 * Counts this database only. Each Vitest worker has its own, so a waiter in
 * another suite is never taken for this one's.
 */
export async function countLockWaits(db: Database): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as waiting
    from pg_stat_activity
    where datname = current_database()
      and wait_event_type = 'Lock'
      and wait_event in ('transactionid', 'tuple')
  `)
  const waiting = rows.at(0)?.waiting

  if (typeof waiting !== 'number') {
    throw new Error(`pg_stat_activity returned no count: ${JSON.stringify(rows)}`)
  }

  return waiting
}
