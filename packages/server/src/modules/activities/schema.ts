import { ACTIVITY_KINDS, RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { index, pgTable, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, primaryId } from '../../lib/columns.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/** Re-exported for the routes and service that constrain themselves to this table. */
export { ACTIVITY_KINDS } from '@kelpie/schemas'
export type { ActivityKind } from '@kelpie/schemas'

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
    checkOneOf('activities_target_type_check', table.targetType, RECORD_TARGET_TYPES),
    checkOneOf('activities_kind_check', table.kind, ACTIVITY_KINDS),
  ],
)
