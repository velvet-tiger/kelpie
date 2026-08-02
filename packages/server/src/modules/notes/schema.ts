import { sql } from 'drizzle-orm'
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/** The target types a note, activity, decision, or plan item can attach to. */
export const RECORD_TARGET_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'candidate',
] as const

/**
 * Notes attach to any CRM object. The target is polymorphic with no database
 * foreign key, so the owning service deletes dependents in the same transaction
 * as the parent.
 *
 * Pinned notes are what agents read first.
 */
export const notes = pgTable(
  'notes',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    body: text('body').notNull(),
    authorId: text('author_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('notes_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    check(
      'notes_target_type_check',
      sql`${table.targetType} in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'candidate')`,
    ),
  ],
)
