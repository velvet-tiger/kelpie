import { sql } from 'drizzle-orm'
import postgres from 'postgres'

import type { Environment } from '../lib/config.ts'
import { connectDatabase } from '../lib/database.ts'
import type { DatabaseConnection } from '../lib/database.ts'
import { createLogger } from '../lib/logger.ts'
import { coreModules } from '../modules/core.ts'
import { runMigrations } from '../runtime/migrate.ts'
import { registerModules } from '../runtime/registry.ts'
import { TEST_ENVIRONMENT } from './environment.ts'
import { createTestServices } from './services.ts'

/**
 * A migrated database for integration tests.
 *
 * Tests connect to the same local Postgres the dev server uses, on a database
 * named by `TEST_DATABASE_URL`. Migrations run once per process; between tests
 * `truncateAll` empties the tables rather than re-migrating, which is an order of
 * magnitude faster and just as isolated.
 */

const silentLogger = createLogger({ level: 'error', transports: [] })

export interface TestDatabase extends DatabaseConnection {
  /** Empties every table. Cheaper than re-running migrations between tests. */
  readonly truncateAll: () => Promise<void>
}

/**
 * Reads the test database location. Integration tests are skipped rather than
 * failed when it is absent, so `npm test` still works without Postgres running.
 */
export function testDatabaseUrl(environment: Environment): string | undefined {
  return environment.TEST_DATABASE_URL
}

/**
 * Creates the target database if it does not exist, by connecting to the server's
 * maintenance database. Saves every contributor a manual `createdb` step.
 */
async function ensureDatabaseExists(connectionString: string): Promise<void> {
  const url = new URL(connectionString)
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ''))

  if (databaseName.length === 0) {
    throw new Error(`TEST_DATABASE_URL has no database name: ${connectionString}`)
  }

  const maintenanceUrl = new URL(connectionString)
  maintenanceUrl.pathname = '/postgres'
  const client = postgres(maintenanceUrl.toString(), { max: 1 })

  try {
    const existing = await client`select 1 from pg_database where datname = ${databaseName}`

    if (existing.length === 0) {
      // CREATE DATABASE cannot be parameterised or run inside a transaction.
      // The name came from a connection string the developer set, not a request.
      await client.unsafe(`create database "${databaseName.replace(/"/gu, '""')}"`)
    }
  } finally {
    await client.end()
  }
}

/**
 * @param connectionString Where to connect. Callers pass `TEST_DATABASE_URL`;
 *   this function never reads the environment itself.
 */
export async function connectTestDatabase(connectionString: string): Promise<TestDatabase> {
  await ensureDatabaseExists(connectionString)

  const connection = connectDatabase(connectionString, silentLogger)
  const contributions = await registerModules({
    modules: coreModules,
    // Enough for core modules to configure themselves; no test reads it further.
    environment: TEST_ENVIRONMENT,
    logger: silentLogger,
    services: createTestServices({ db: connection.db }),
  })

  await runMigrations(connection.db, contributions.schemas, silentLogger)

  async function truncateAll(): Promise<void> {
    // Names come from the catalog, not from user input, and every migrations
    // table is excluded so truncation does not undo the migration record.
    const rows = await connection.db.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
        and table_name not like '\\_\\_drizzle\\_%'
    `)

    const names = [...rows].map((row) => `"${row.table_name}"`)

    if (names.length === 0) {
      return
    }

    await connection.db.execute(sql.raw(`truncate table ${names.join(', ')} restart identity cascade`))
  }

  return { ...connection, truncateAll }
}
