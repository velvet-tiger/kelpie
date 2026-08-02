import { type AnyPgColumn, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * The company brain: nested markdown pages agents read over the same API as CRM
 * records.
 *
 * Depth (max 4) and the no-descendant-cycles rule are enforced in the service
 * layer; a self-referencing foreign key can express the tree but not its bounds.
 */
export const handbookPages = pgTable(
  'handbook_pages',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    parentId: text('parent_id').references((): AnyPgColumn => handbookPages.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    body: text('body').notNull().default(''),
    updatedBy: text('updated_by').references(() => workspaceMembers.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('handbook_pages_workspace_slug_key').on(table.workspaceId, table.slug),
    index('handbook_pages_parent_idx').on(table.workspaceId, table.parentId),
  ],
)
