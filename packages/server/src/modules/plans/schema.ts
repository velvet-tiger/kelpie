import { sql } from 'drizzle-orm'
import { check, date, index, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * Dated action items on the four pipelines. These replace any next-step text
 * field: a plan item is queryable, has an owner, and can be overdue.
 *
 * The target set is narrower than notes and decisions, which attach to people and
 * companies too.
 */
export const planItems = pgTable(
  'plan_items',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    date: date('date').notNull(),
    title: text('title').notNull(),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('todo'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('plan_items_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    index('plan_items_date_idx').on(table.workspaceId, table.date),
    check(
      'plan_items_target_type_check',
      sql`${table.targetType} in ('deal', 'opportunity', 'raise', 'partnership')`,
    ),
    check('plan_items_status_check', sql`${table.status} in ('todo', 'in_progress', 'done')`),
  ],
)
