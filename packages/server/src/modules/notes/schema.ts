import { RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { boolean, index, pgTable, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * The target types come from `@kelpie/schemas`, so this check constraint, the
 * route's Zod enum, and the browser's decoder are one list rather than three
 * copies. Re-exported because `routes.ts` and `service.ts` read them from here,
 * and the table they constrain is the reason they matter.
 */
export { RECORD_TARGET_TYPES } from '@kelpie/schemas'
export type { RecordTargetType } from '@kelpie/schemas'

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
    checkOneOf('notes_target_type_check', table.targetType, RECORD_TARGET_TYPES),
  ],
)
