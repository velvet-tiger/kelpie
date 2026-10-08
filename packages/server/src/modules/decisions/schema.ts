import { RECORD_TARGET_TYPES, WRITE_ORIGINS } from '@kelpie/schemas'
import type { WriteOrigin } from '@kelpie/schemas'
import { index, pgTable, text } from 'drizzle-orm/pg-core'

import {
  checkOneOf,
  createdAt,
  moment,
  primaryId,
  searchVector,
  updatedAt,
} from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
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
 * What we decided or promised. These are the commitments agents must not
 * contradict, which is why they are a queryable record rather than note text.
 *
 * `origin` is what wrote the row: a member, an agent with a bearer credential,
 * or a model. `unknown` is a row from before the column. The column has no
 * default here, so every insert must say. The service derives it from the
 * actor and never from a request, and lowers it when a caller that is not a
 * member rewrites the body or the rationale.
 *
 * `confirmedAt` is null while a Decision is a proposal. Only a hosted AI run
 * makes one: a run writes with no person approving it, so what it writes is
 * not a commitment until a member says so. `confirmedById` is the member who
 * said so, and is null for a row that was confirmed when it was written by an
 * agent or before the column existed. It is `ON DELETE SET NULL`, not
 * `RESTRICT` like `ownerId`: a confirmation cannot be handed to another
 * member, so a restriction would make the member impossible to remove. The
 * time of the confirmation stays.
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
    origin: text('origin').$type<WriteOrigin>().notNull(),
    confirmedAt: moment('confirmed_at'),
    confirmedById: text('confirmed_by_id').references(() => workspaceMembers.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // The body carries weight A because a decision has no name: the body is what
    // the result list shows and what a reader recognises it by.
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: decisions.body, weight: 'A' },
      { column: decisions.rationale, weight: 'B' },
    ]),
  },
  (table) => [
    index('decisions_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    index('decisions_search_idx').using('gin', table.searchVector),
    checkOneOf('decisions_target_type_check', table.targetType, RECORD_TARGET_TYPES),
    checkOneOf('decisions_origin_check', table.origin, WRITE_ORIGINS),
  ],
)
