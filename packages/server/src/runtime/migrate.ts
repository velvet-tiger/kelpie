import { migrate } from 'drizzle-orm/postgres-js/migrator'

import type { Database } from '../lib/database.ts'
import type { Logger } from '../lib/logger.ts'
import type { SchemaContribution } from './module.ts'

/**
 * Applies pending migrations for every directory the registered modules
 * contributed.
 *
 * Core modules all share one directory, so directories are deduplicated and each
 * runs once. Each gets its own migrations table: Drizzle tracks progress with a
 * single high-water timestamp per table, so two directories sharing one would
 * make the second silently skip anything older than the first's newest migration.
 *
 * Migrations are forward-only. Running this twice is a no-op.
 */
export interface MigrationPlanStep {
  readonly migrationsDirectory: string
  readonly migrationsTable: string
  readonly moduleIds: readonly string[]
}

/** Postgres identifiers are 63 bytes; module ids are short, but hyphens are not legal unquoted. */
function migrationsTableFor(moduleId: string): string {
  return `__drizzle_migrations_${moduleId.replace(/[^a-z0-9]+/giu, '_').toLowerCase()}`
}

/**
 * Groups schema contributions into one step per directory.
 *
 * Pure, so the plan can be asserted without a database. The first module to claim
 * a directory names its migrations table; the rest ride along.
 */
export function planMigrations(contributions: readonly SchemaContribution[]): readonly MigrationPlanStep[] {
  const steps = new Map<string, { migrationsTable: string; moduleIds: string[] }>()

  for (const contribution of contributions) {
    const existing = steps.get(contribution.migrationsDir)

    if (existing === undefined) {
      steps.set(contribution.migrationsDir, {
        migrationsTable: migrationsTableFor(contribution.moduleId),
        moduleIds: [contribution.moduleId],
      })
      continue
    }

    existing.moduleIds.push(contribution.moduleId)
  }

  return [...steps].map(([migrationsDirectory, step]) => ({
    migrationsDirectory,
    migrationsTable: step.migrationsTable,
    moduleIds: step.moduleIds,
  }))
}

export async function runMigrations(
  db: Database,
  contributions: readonly SchemaContribution[],
  logger: Logger,
): Promise<void> {
  for (const step of planMigrations(contributions)) {
    await migrate(db, {
      migrationsFolder: step.migrationsDirectory,
      migrationsTable: step.migrationsTable,
    })

    logger.info('migrations applied', {
      directory: step.migrationsDirectory,
      modules: step.moduleIds,
    })
  }
}
