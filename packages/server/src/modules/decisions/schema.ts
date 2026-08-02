import { sql } from 'drizzle-orm'
import { check, index, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * What we decided or promised. These are the commitments agents must not
 * contradict, which is why they are a queryable record rather than note text.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    body: text('body').notNull(),
    rationale: text('rationale'),
    decidedAt: moment('decided_at').notNull().defaultNow(),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    dueAt: moment('due_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('decisions_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    check(
      'decisions_target_type_check',
      sql`${table.targetType} in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'candidate')`,
    ),
  ],
)
