import { sql } from 'drizzle-orm'
import { check, index, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * System history, rolled up onto person and company timelines. Append-only: there
 * is no update route and no `updated_at`.
 *
 * `actor_label` carries the display name when there is no member behind the
 * action, e.g. "Form" or "Gmail".
 */
export const activities = pgTable(
  'activities',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    kind: text('kind').notNull(),
    actorMemberId: text('actor_member_id').references(() => workspaceMembers.id, {
      onDelete: 'set null',
    }),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (table) => [
    index('activities_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    check(
      'activities_target_type_check',
      sql`${table.targetType} in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'candidate')`,
    ),
    check(
      'activities_kind_check',
      sql`${table.kind} in ('created', 'updated', 'stage_changed', 'note_added', 'email', 'call', 'meeting', 'linked')`,
    ),
  ],
)
