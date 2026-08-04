import {
  IMPORT_CONFLICT_MODES,
  IMPORT_JOB_STATUSES,
  IMPORT_OBJECTS,
  IMPORT_ROW_ACTIONS,
  IMPORT_SOURCES,
} from '@kelpie/schemas'
import type { ImportColumnMap, ImportCounts } from '@kelpie/schemas'
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
 * `column_map` and `counts` are jsonb because their shape follows the object
 * being imported and nothing queries into them. The row errors and the mapping
 * preview are **not** stored here: both are derived from `import_job_rows`, so
 * there is one account of what happened to a row rather than two that can
 * disagree.
 *
 * `file_name` is what the uploader called the file, for the mapping screen. The
 * file body itself is not kept — the parsed rows are, which is what a commit
 * replays.
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
 * One data row of the uploaded file.
 *
 * `values` holds the row as it arrived — **source header → cell** — not the
 * mapped Kelpie columns. Mapping is applied on every read, so the job's
 * `column_map` stays the single account of how the file is being read, and a
 * corrected mapping is a fresh job over the same file rather than two stored
 * shapes that can disagree.
 *
 * `action` is a forecast until the job commits, at which point the commit writes
 * back what it actually did.
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
