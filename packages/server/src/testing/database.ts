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
import { TEST_EMAIL_FROM, TEST_EMAIL_PROVIDER, createTestServices } from './services.ts'

/**
 * A migrated database for integration tests.
 *
 * Tests connect to the same local Postgres the dev server uses, on a database
 * named by `TEST_DATABASE_URL` — suffixed per Vitest worker, so test files can
 * run in parallel without sharing tables. Migrations run once per process;
 * between tests `truncateAll` empties the tables rather than re-migrating.
 *
 * The reset deletes rather than truncates. TRUNCATE rebuilds every relation
 * file and syncs it to disk, which measured 590-830ms per call against
 * Dockerised Postgres; DELETE across the same mostly-empty tables is under a
 * millisecond. Deletes run children-first so no foreign key is ever violated.
 */

const silentLogger = createLogger({ level: 'error', transports: [] })

export interface TestDatabase extends DatabaseConnection {
  /** Empties every table. Cheaper than truncating or re-migrating between tests. */
  readonly truncateAll: () => Promise<void>
}

/**
 * Reads the test database location. Integration tests are skipped rather than
 * failed when it is absent, so `npm test` still works without Postgres running.
 *
 * Inside a Vitest worker the configured name gains the worker's pool id, so
 * every worker owns its own database and test files can run in parallel.
 * `connectTestDatabase` creates and migrates a missing database on first use.
 */
export function testDatabaseUrl(environment: Environment): string | undefined {
  const configured = environment.TEST_DATABASE_URL
  const poolId = environment.VITEST_POOL_ID

  if (configured === undefined || poolId === undefined) {
    return configured
  }

  const url = new URL(configured)
  url.pathname = `${url.pathname}_${poolId}`
  return url.toString()
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
  const services = createTestServices({ db: connection.db })
  const contributions = await registerModules({
    modules: coreModules,
    // Enough for core modules to configure themselves; no test reads it further.
    environment: TEST_ENVIRONMENT,
    logger: silentLogger,
    services,
    email: { provider: TEST_EMAIL_PROVIDER, from: TEST_EMAIL_FROM },
    additionalEmailProviders: new Map([[TEST_EMAIL_PROVIDER, services.emailSender]]),
  })

  await runMigrations(connection.db, contributions.schemas, silentLogger)

  let cachedReset: string | undefined

  /**
   * Builds one `DO` block that deletes from every table, each table after
   * every table that references it, so a plain DELETE never trips a foreign
   * key. Built once per connection: the table set only changes with the
   * migrations, which already ran.
   */
  async function buildResetStatement(): Promise<string | undefined> {
    // Names come from the catalog, not from user input, and every migrations
    // table is excluded so the reset does not undo the migration record.
    const tables = await connection.db.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
        and table_name not like '\\_\\_drizzle\\_%'
    `)

    const names = [...tables].map((row) => row.table_name)

    if (names.length === 0) {
      return undefined
    }

    // Distinct pairs, so two foreign keys between the same tables do not
    // count twice. Self-references are dropped: deleting every row of a table
    // in one statement satisfies its own constraint.
    const references = await connection.db.execute<{ child: string; parent: string }>(sql`
      select distinct child.relname as child, parent.relname as parent
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_class parent on parent.oid = con.confrelid
      where con.contype = 'f'
        and con.connamespace = 'public'::regnamespace
        and con.conrelid <> con.confrelid
    `)

    const included = new Set(names)
    const parentsOf = new Map<string, string[]>()
    const inboundReferences = new Map<string, number>(names.map((name) => [name, 0]))

    for (const { child, parent } of references) {
      if (!included.has(child) || !included.has(parent)) {
        continue
      }

      parentsOf.set(child, [...(parentsOf.get(child) ?? []), parent])
      inboundReferences.set(parent, (inboundReferences.get(parent) ?? 0) + 1)
    }

    // Kahn's algorithm. A table joins the order once every table referencing
    // it is already in it, which is exactly when deleting from it is safe.
    const ordered = names.filter((name) => inboundReferences.get(name) === 0)

    for (let index = 0; index < ordered.length; index += 1) {
      const table = ordered[index]

      if (table === undefined) {
        continue
      }

      for (const parent of parentsOf.get(table) ?? []) {
        const remaining = (inboundReferences.get(parent) ?? 0) - 1
        inboundReferences.set(parent, remaining)

        if (remaining === 0) {
          ordered.push(parent)
        }
      }
    }

    if (ordered.length !== names.length) {
      throw new Error('cannot order the table deletes: the foreign keys form a cycle')
    }

    const deletes = ordered.map((name) => `delete from "${name.replace(/"/gu, '""')}";`).join(' ')
    return `do $reset$ begin ${deletes} end $reset$;`
  }

  async function truncateAll(): Promise<void> {
    cachedReset ??= await buildResetStatement()

    if (cachedReset !== undefined) {
      await connection.db.execute(sql.raw(cachedReset))
    }
  }

  return { ...connection, truncateAll }
}
