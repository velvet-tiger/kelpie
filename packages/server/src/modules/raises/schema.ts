import { bigint, date, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * A fundraising process with one firm in one round. `company_id` is the firm.
 * The ongoing relationship with that firm stays a Partnership; this row tracks
 * the process and ends at closed or passed.
 */
export const raises = pgTable(
  'raises',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    stageId: text('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    checkSizeCents: bigint('check_size_cents', { mode: 'number' }),
    currency: text('currency'),
    thesisFit: text('thesis_fit').notNull().default(''),
    passReason: text('pass_reason'),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    expectedClose: date('expected_close'),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('raises_workspace_idx').on(table.workspaceId),
    index('raises_company_idx').on(table.companyId),
    index('raises_stage_idx').on(table.stageId),
  ],
)

export const raisePeople = pgTable(
  'raise_people',
  {
    raiseId: text('raise_id')
      .notNull()
      .references(() => raises.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.raiseId, table.personId] })],
)
