import { RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { foreignKey, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The target types come from `@kelpie/schemas`, so this check constraint, the
 * route's Zod enum, and the browser's decoder are one list rather than three
 * copies. Re-exported because `routes.ts` reads them from here, and the tables
 * they constrain are the reason they matter.
 */
export { RECORD_TARGET_TYPES } from '@kelpie/schemas'
export type { RecordTargetType } from '@kelpie/schemas'

/**
 * A named collection of records of one type.
 *
 * The `target_type` is chosen at creation and never changes. A `list_members`
 * row's `(list_id, target_type)` foreign-keys back into the composite unique on
 * this table, so adding a person to a company list is refused by the database
 * rather than trusted to the service.
 *
 * `(workspace_id, name)` is unique so the sidebar never shows two lists with the
 * same label. Renaming to an in-use name returns 409.
 */
export const lists = pgTable(
  'lists',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    targetType: text('target_type').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('lists_workspace_idx').on(table.workspaceId),
    unique('lists_workspace_name_key').on(table.workspaceId, table.name),
    // The referent of the composite FK from `list_members`. Postgres requires a
    // unique key over the referenced columns; this exists solely to satisfy it.
    unique('lists_id_target_type_key').on(table.id, table.targetType),
    checkOneOf('lists_target_type_check', table.targetType, RECORD_TARGET_TYPES),
  ],
)

/**
 * A record's membership in a list.
 *
 * `(list_id, target_type)` foreign-keys back to the list's own unique key, so
 * the member's type must equal its parent list's. The target itself is
 * polymorphic and carries no foreign key of its own; the owning service checks
 * existence with `missingTargets` and removes the row when the target goes
 * (`attachedRecords.ts`).
 */
export const listMembers = pgTable(
  'list_members',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    listId: text('list_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    // A membership is not edited, only added or removed, so no `updated_at`.
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('list_members_list_idx').on(table.workspaceId, table.listId),
    index('list_members_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    unique('list_members_list_target_key').on(table.listId, table.targetId),
    foreignKey({
      name: 'list_members_list_target_type_fk',
      columns: [table.listId, table.targetType],
      foreignColumns: [lists.id, lists.targetType],
    }).onDelete('cascade'),
    checkOneOf('list_members_target_type_check', table.targetType, RECORD_TARGET_TYPES),
  ],
)
