import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * A CSV import, from upload through dry run to commit. Append-only once
 * completed: the counts and errors are the record of what happened.
 *
 * `column_map`, `counts`, and `errors` are jsonb because their shape follows the
 * object being imported and nothing queries into them.
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
    columnMap: jsonb('column_map').notNull().default({}),
    counts: jsonb('counts').notNull().default({}),
    errors: jsonb('errors').notNull().default([]),
    fileRef: text('file_ref'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('import_jobs_workspace_idx').on(table.workspaceId),
    check('import_jobs_source_check', sql`${table.source} in ('custom', 'hubspot', 'salesforce')`),
    check(
      'import_jobs_object_check',
      sql`${table.object} in ('people', 'companies', 'positions', 'deals')`,
    ),
    check('import_jobs_conflict_mode_check', sql`${table.conflictMode} in ('skip', 'update')`),
  ],
)
