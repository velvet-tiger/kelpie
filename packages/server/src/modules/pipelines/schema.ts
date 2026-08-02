import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Board columns for all four pipelines. `slug` is the stable id imports alias to;
 * `label` is what the board shows and is free to change.
 *
 * Seeded per workspace at creation. Deleting a stage is restricted while records
 * reference it; the API's remove-with-reassign moves records first.
 */
export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    open: boolean('open').notNull().default(true),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('pipeline_stages_workspace_kind_slug_key').on(table.workspaceId, table.kind, table.slug),
    index('pipeline_stages_workspace_kind_idx').on(table.workspaceId, table.kind),
    check(
      'pipeline_stages_kind_check',
      sql`${table.kind} in ('deal', 'opportunity', 'raise', 'partnership')`,
    ),
  ],
)
