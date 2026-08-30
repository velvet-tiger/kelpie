import type { CustomFieldValue } from '@kelpie/schemas'
import { bigint, date, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, searchVector, updatedAt } from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
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
    // Workspace-defined fields, keyed by definition key. See people/schema.ts.
    customFields: jsonb('custom_fields')
      .$type<Readonly<Record<string, CustomFieldValue>>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: raises.name, weight: 'A' },
      { column: raises.thesisFit, weight: 'B' },
      { column: raises.passReason, weight: 'B' },
      { column: raises.summary, weight: 'B' },
      { column: raises.tags, weight: 'C', array: true },
    ]),
  },
  (table) => [
    index('raises_workspace_idx').on(table.workspaceId),
    index('raises_company_idx').on(table.companyId),
    index('raises_stage_idx').on(table.stageId),
    index('raises_search_idx').using('gin', table.searchVector),
  ],
)

