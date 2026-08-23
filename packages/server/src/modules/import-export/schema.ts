import {
  IMPORT_CONFLICT_MODES,
  IMPORT_JOB_STATUSES,
  IMPORT_OBJECTS,
  IMPORT_ROW_ACTIONS,
  IMPORT_SOURCES,
  ON_MISSING_COMPANY,
} from '@kelpie/schemas'
import type {
  ImportColumnMap,
  ImportCounts,
  ImportPreviewRow,
  ImportRowError,
} from '@kelpie/schemas'
import { index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The fixed value sets come from `@kelpie/schemas`, so these check constraints,
 * the route's Zod enums, and the browser's decoder are one list rather than
 * three copies.
 */
export {
  IMPORT_CONFLICT_MODES,
  IMPORT_JOB_STATUSES,
  IMPORT_OBJECTS,
  IMPORT_ROW_ACTIONS,
  IMPORT_SOURCES,
} from '@kelpie/schemas'
export type {
  ImportConflictMode,
  ImportJobStatus,
  ImportObject,
  ImportRowAction,
  ImportSource,
  SettledRowAction,
} from '@kelpie/schemas'

/** One problem with one cell, as stored against the row that carries it. */
export interface StoredRowError {
  readonly field: string
  readonly message: string
}

/**
 * A CSV import, from upload through dry run to commit.
 *
 * `column_map`, `counts`, `errors` and `preview` are jsonb because their shape
 * follows the object being imported and nothing queries into them.
 *
 * A job stores no part of the file. The upload plans it in memory and keeps
 * `counts`, `errors`, `preview` and `file_sha256`; the caller keeps the file and
 * hands it back at commit. That is what makes an abandoned dry run cost one row
 * rather than a copy of a ten megabyte upload, and it is why nothing is exploded
 * into `import_job_rows` until an import actually runs.
 *
 * `file_name` is what the uploader called the file, for the mapping screen.
 */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    object: text('object').notNull(),
    status: text('status').notNull(),
    conflictMode: text('conflict_mode').notNull(),
    /**
     * What a People import does with a row naming a company that is not here
     * yet: `skip` leaves the affiliation unlinked and warns, `create` invents
     * the company. Defaulted so a job predating this reads as `skip`, which is
     * the behaviour every other object already has.
     */
    onMissingCompany: text('on_missing_company').notNull().default('skip'),
    matchKey: text('match_key').notNull(),
    columnMap: jsonb('column_map').$type<ImportColumnMap>().notNull().default({}),
    sourceHeaders: jsonb('source_headers').$type<readonly string[]>().notNull().default([]),
    counts: jsonb('counts').$type<ImportCounts>().notNull(),
    /** The first `IMPORT_REPORTED_ERRORS` failing rows. `counts.error` is the true number. */
    errors: jsonb('errors').$type<readonly ImportRowError[]>().notNull().default([]),
    /** The first `IMPORT_REPORTED_ERRORS` non-fatal notes, e.g. a person imported with the position skipped. */
    warnings: jsonb('warnings').$type<readonly ImportRowError[]>().notNull().default([]),
    /** The first `IMPORT_PREVIEW_ROWS` rows, mapped as Kelpie read them. */
    preview: jsonb('preview').$type<readonly ImportPreviewRow[]>().notNull().default([]),
    /**
     * SHA-256 of the file this job forecast, hex.
     *
     * The file itself is not kept. The commit carries it back and is refused if
     * it hashes to anything else, which buys the same "this is the file you
     * approved" guarantee as storing it for 64 characters instead of up to ten
     * megabytes. Null only on a job from before this, which cannot be committed;
     * the remedy is the one `import-export.md` already gives — upload it again.
     */
    fileSha256: text('file_sha256'),
    fileName: text('file_name'),
    /** Why a background pass gave up. Null unless `status` is `failed`. */
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('import_jobs_workspace_idx').on(table.workspaceId),
    checkOneOf('import_jobs_source_check', table.source, IMPORT_SOURCES),
    checkOneOf('import_jobs_object_check', table.object, IMPORT_OBJECTS),
    checkOneOf('import_jobs_conflict_mode_check', table.conflictMode, IMPORT_CONFLICT_MODES),
    checkOneOf('import_jobs_on_missing_company_check', table.onMissingCompany, ON_MISSING_COMPANY),
    checkOneOf('import_jobs_status_check', table.status, IMPORT_JOB_STATUSES),
  ],
)

/**
 * What an import did to one line of the file.
 *
 * Written by the commit, one row at a time, in the same transaction as the
 * record that row wrote. Nothing here exists before then: a dry run forecasts
 * without storing, so a caller who corrects a mapping four times leaves four
 * jobs and no rows rather than four copies of the file.
 *
 * `action` is therefore always what happened, never a forecast. `values` holds
 * the line as it arrived — **source header → cell** — so the row says what it
 * acted on without the reader having to go back to `import_jobs.csv` and count
 * lines.
 */
export const importJobRows = pgTable(
  'import_job_rows',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),
    /** The line in the file, counting the header as line 1. Data starts at 2. */
    rowNumber: integer('row_number').notNull(),
    values: jsonb('values').$type<Readonly<Record<string, string>>>().notNull().default({}),
    action: text('action').notNull(),
    errors: jsonb('errors').$type<readonly StoredRowError[]>().notNull().default([]),
    /** Non-fatal notes about a row that was applied anyway, e.g. an unlinked position. */
    warnings: jsonb('warnings').$type<readonly StoredRowError[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The job and the line already identify a row, so it needs no id of its own.
    // A `<prefix>_<ulid>` here would also mean a prefix `api.md` does not
    // document, for something that never appears on the wire.
    primaryKey({ columns: [table.jobId, table.rowNumber] }),
    index('import_job_rows_workspace_idx').on(table.workspaceId),
    checkOneOf('import_job_rows_action_check', table.action, IMPORT_ROW_ACTIONS),
  ],
)
