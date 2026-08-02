import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '../schema/index.ts'
import { describeThrown } from './errors.ts'

export type Database = PostgresJsDatabase<typeof schema>

/** Outcome of a connectivity check. Carries the reason instead of throwing. */
export type DatabaseProbe = { readonly reachable: true } | { readonly reachable: false; readonly reason: string }

export interface DatabaseConnection {
  readonly db: Database
  /** Round-trips a trivial query. Used by the health endpoint. */
  readonly probe: () => Promise<DatabaseProbe>
  readonly close: () => Promise<void>
}

/**
 * Opens a lazy Postgres connection pool and wraps it in Drizzle.
 *
 * @param connectionString Validated by the config layer, never read from env here.
 */
export function connectDatabase(connectionString: string): DatabaseConnection {
  const client = postgres(connectionString)
  const db = drizzle(client, { schema })

  async function probe(): Promise<DatabaseProbe> {
    try {
      await client`select 1`
      return { reachable: true }
    } catch (error: unknown) {
      // A probe reports unreachability; propagating would turn a health check
      // into an outage. The reason is returned so the caller can log it.
      return { reachable: false, reason: describeThrown(error) }
    }
  }

  return {
    db,
    probe,
    close: () => client.end(),
  }
}
