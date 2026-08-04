import { CANDIDATE_STATUSES, INTERVIEW_STAGES, ROLE_STATUSES } from '@kelpie/schemas'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, oneOf, primaryId, updatedAt } from '../../lib/columns.ts'
import { people } from '../people/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The value sets come from `@kelpie/schemas`, so these check constraints, the
 * routes' Zod enums, and the browser's dropdowns are one list rather than three
 * copies. Re-exported because `service.ts` and `routes.ts` read them from here,
 * and the tables they constrain are the reason they matter.
 */
export {
  CANDIDATE_STATUSES,
  CANDIDATE_STATUS_LABELS,
  FIRST_INTERVIEW_STAGE,
  IN_PROCESS,
  INTERVIEW_STAGES,
  INTERVIEW_STAGE_LABELS,
  ROLE_STATUSES,
} from '@kelpie/schemas'
export type { CandidateStatus, InterviewStage, RoleStatus } from '@kelpie/schemas'

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
    checkOneOf('roles_status_check', table.status, ROLE_STATUSES),
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
    referrerPersonId: text('referrer_person_id').references(() => people.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('candidates_role_person_key').on(table.roleId, table.personId),
    index('candidates_workspace_idx').on(table.workspaceId),
    checkOneOf('candidates_status_check', table.status, CANDIDATE_STATUSES),
    check(
      'candidates_interview_stage_check',
      sql`${table.interviewStage} is null or ${oneOf('candidates_interview_stage_check', table.interviewStage, INTERVIEW_STAGES)}`,
    ),
  ],
)
