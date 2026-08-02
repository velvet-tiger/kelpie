import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { people } from '../people/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/** An opening the workspace is hiring for. Candidates attach here, never to Person. */
export const roles = pgTable(
  'roles',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('roles_workspace_idx').on(table.workspaceId),
    check('roles_status_check', sql`${table.status} in ('open', 'closed')`),
  ],
)

/**
 * The Person-to-Role link. Pipeline state lives here.
 *
 * `interview_stage` is null unless `status` is `in_process`. That rule is
 * enforced in the service layer, mirroring the mockup's `candidatePatchForStatus`,
 * because a check constraint cannot express it without pinning the transition
 * order too.
 */
export const candidates = pgTable(
  'candidates',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    interviewStage: text('interview_stage'),
    referrerPersonId: text('referrer_person_id').references(() => people.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('candidates_role_person_key').on(table.roleId, table.personId),
    index('candidates_workspace_idx').on(table.workspaceId),
    check(
      'candidates_status_check',
      sql`${table.status} in ('in_process', 'nurture', 'hired', 'passed', 'withdrawn')`,
    ),
    check(
      'candidates_interview_stage_check',
      sql`${table.interviewStage} is null or ${table.interviewStage} in ('sourced', 'screen', 'interview', 'offer')`,
    ),
  ],
)
