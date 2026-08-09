import { PIPELINE_KINDS, PLAN_ITEM_STATUSES } from '@kelpie/schemas'
import { date, index, pgTable, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, primaryId, searchVector, updatedAt } from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/** Re-exported for the routes and service that constrain themselves to this table. */
export { PIPELINE_KINDS, PLAN_ITEM_STATUSES } from '@kelpie/schemas'
export type { PipelineKind, PlanItemStatus } from '@kelpie/schemas'

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
    // A plan item is never a search result itself. This vector exists so a search
    // for a planned step finds the Deal, Opportunity or Raise it sits on.
    searchVector: searchVector((): readonly SearchVectorPart[] => [{ column: planItems.title, weight: 'A' }]),
  },
  (table) => [
    index('plan_items_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    index('plan_items_date_idx').on(table.workspaceId, table.date),
    index('plan_items_search_idx').using('gin', table.searchVector),
    checkOneOf('plan_items_target_type_check', table.targetType, PIPELINE_KINDS),
    checkOneOf('plan_items_status_check', table.status, PLAN_ITEM_STATUSES),
  ],
)
