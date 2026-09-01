import { sql } from 'drizzle-orm'
import { check, date, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { PIPELINE_KINDS } from '@kelpie/schemas'
import type { CustomFieldValue } from '@kelpie/schemas'

import { createdAt, oneOf, primaryId, searchVector, updatedAt } from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * Ongoing two-way relationships. Status is a pipeline stage of kind
 * `partnership`. There is no favour ledger (`brief.md` non-goal).
 */
export const partnerships = pgTable(
  'partnerships',
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
    kind: text('kind').notNull(),
    nextTouchpoint: date('next_touchpoint'),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    goals: text('goals').notNull().default(''),
    successLooksLike: text('success_looks_like').notNull().default(''),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    convertedTargetType: text('converted_target_type'),
    convertedTargetId: text('converted_target_id'),
    // Workspace-defined fields, keyed by definition key. See people/schema.ts.
    customFields: jsonb('custom_fields')
      .$type<Readonly<Record<string, CustomFieldValue>>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: partnerships.name, weight: 'A' },
      { column: partnerships.kind, weight: 'B' },
      { column: partnerships.goals, weight: 'B' },
      { column: partnerships.successLooksLike, weight: 'B' },
      { column: partnerships.summary, weight: 'B' },
      { column: partnerships.tags, weight: 'C', array: true },
    ]),
  },
  (table) => [
    index('partnerships_workspace_idx').on(table.workspaceId),
    index('partnerships_company_idx').on(table.companyId),
    index('partnerships_stage_idx').on(table.stageId),
    index('partnerships_search_idx').using('gin', table.searchVector),
    check(
      'partnerships_converted_target_type_check',
      sql`${table.convertedTargetType} is null or ${oneOf('partnerships_converted_target_type_check', table.convertedTargetType, PIPELINE_KINDS)}`,
    ),
  ],
)

