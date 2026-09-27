import { ACTIVITY_KINDS, RECORD_REFERENCE_TYPES, RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, oneOf, primaryId } from '../../lib/columns.ts'
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
 *
 * `subject_type` and `subject_id` name the record the row is about, when that is
 * not the record it is filed on: the note that was added, the company a person
 * was linked to, the form a deal came in through. Null when there is none. The
 * pair has no foreign key, like the target: a deleted subject leaves the row as
 * history, and it simply stops resolving to a name.
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
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('activities_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    checkOneOf('activities_target_type_check', table.targetType, RECORD_TARGET_TYPES),
    checkOneOf('activities_kind_check', table.kind, ACTIVITY_KINDS),
    check(
      'activities_subject_type_check',
      sql`${table.subjectType} is null or ${oneOf('activities_subject_type_check', table.subjectType, RECORD_REFERENCE_TYPES)}`,
    ),
    // A type with no id, or an id with no type, names nothing.
    check('activities_subject_pair_check', sql`(${table.subjectType} is null) = (${table.subjectId} is null)`),
  ],
)
