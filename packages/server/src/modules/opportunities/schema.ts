import { date, index, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * Non-sales chances: grants, accelerators, tenders, press, speaking. Not an alias
 * for Deal.
 *
 * `company_id` is nullable because a speaking slot or a grant need not belong to
 * a company on file.
 */
export const opportunities = pgTable(
  'opportunities',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    stageId: text('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    expectedClose: date('expected_close'),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('opportunities_workspace_idx').on(table.workspaceId),
    index('opportunities_stage_idx').on(table.stageId),
  ],
)
