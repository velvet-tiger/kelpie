import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '../schema/index.ts'
import { describeThrown } from './errors.ts'
import type { Logger } from './logger.ts'

export type Database = PostgresJsDatabase<typeof schema>

/**
 * SQLSTATE raised by an explicit `ON DELETE RESTRICT`. Postgres uses this rather
 * than 23503 when the constraint itself is what refused.
 */
export const RESTRICT_VIOLATION = '23001'

/** SQLSTATE raised when a reference is violated without an explicit RESTRICT rule. */
export const FOREIGN_KEY_VIOLATION = '23503'

/** SQLSTATE for a unique violation, e.g. two people with one email in a workspace. */
export const UNIQUE_VIOLATION = '23505'

/**
 * Reads a field off a driver error. Drizzle wraps driver errors in its own
 * `Failed query` error, so the useful fields live on the cause rather than the
 * top level.
 */
function driverErrorField(error: unknown, field: string): string | undefined {
  const candidates: readonly unknown[] = [error, error instanceof Error ? error.cause : undefined]

  for (const candidate of candidates) {
    if (candidate instanceof Error && field in candidate) {
      const value: unknown = (candidate as unknown as Record<string, unknown>)[field]

      if (typeof value === 'string') {
        return value
      }
    }
  }

  return undefined
}

/**
 * Digs the SQLSTATE out of a thrown value.
 *
 * @returns The five-character SQLSTATE, or undefined if this was not a database error.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  return driverErrorField(error, 'code')
}

/**
 * The table that still references the row a delete tried to remove.
 *
 * Postgres names the *referencing* table, which is what `api.md` wants in the
 * `details` of the 409: the caller needs to know what to detach, not which
 * constraint object refused.
 *
 * @returns undefined when the error carries no table, which every caller must
 *   tolerate: the 409 is still correct without it.
 */
export function referenceViolationTable(error: unknown): string | undefined {
  return driverErrorField(error, 'table_name')
}

/**
 * True when the database refused a write because another row still references the
 * target. `api.md` renders this as `409` with the referencing types in `details`.
 */
export function isReferenceViolation(error: unknown): boolean {
  const code = postgresErrorCode(error)

  return code === RESTRICT_VIOLATION || code === FOREIGN_KEY_VIOLATION
}

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
 * @param logger Receives server notices. Without this the driver prints them to
 *   stdout as loose objects, which breaks the JSON-lines log contract.
 */
export function connectDatabase(connectionString: string, logger: Logger): DatabaseConnection {
  const client = postgres(connectionString, {
    onnotice: (notice) => {
      logger.debug('postgres notice', { code: notice.code, notice: notice.message })
    },
  })
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
