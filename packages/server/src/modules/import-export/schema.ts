import {
  IMPORT_CONFLICT_MODES,
  IMPORT_JOB_STATUSES,
  IMPORT_OBJECTS,
  IMPORT_ROW_ACTIONS,
  IMPORT_SOURCES,
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
 * `csv` is the file exactly as it arrived, and it is the only copy of it before
 * a commit. Nothing is exploded into `import_job_rows` until an import actually
 * runs: a dry run is a forecast, and a forecast that stored ten thousand rows
 * per corrected mapping was charging a caller for work nobody asked to keep. The
 * dry run parses this column, plans in memory, and writes back the three things
 * a caller reads — `counts`, `errors` and `preview`.
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
    matchKey: text('match_key').notNull(),
    columnMap: jsonb('column_map').$type<ImportColumnMap>().notNull().default({}),
    sourceHeaders: jsonb('source_headers').$type<readonly string[]>().notNull().default([]),
    counts: jsonb('counts').$type<ImportCounts>().notNull(),
    /** The first `IMPORT_REPORTED_ERRORS` failing rows. `counts.error` is the true number. */
    errors: jsonb('errors').$type<readonly ImportRowError[]>().notNull().default([]),
    /** The first `IMPORT_PREVIEW_ROWS` rows, mapped as Kelpie read them. */
    preview: jsonb('preview').$type<readonly ImportPreviewRow[]>().notNull().default([]),
    /**
     * The uploaded file, verbatim. Null only on a job created before imports
     * stopped storing their rows up front; such a job cannot be committed, and
     * the remedy is the one `import-export.md` already gives — upload it again.
     */
    csv: text('csv'),
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
