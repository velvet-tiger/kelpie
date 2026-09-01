import { sql } from 'drizzle-orm'
import { check, bigint, date, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { PIPELINE_KINDS } from '@kelpie/schemas'
import type { CustomFieldValue } from '@kelpie/schemas'

import { createdAt, oneOf, primaryId, searchVector, updatedAt } from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * The sales pipeline. Money is integer cents plus a currency code, never a float
 * (`api.md`).
 *
 * Company, stage, and owner are all restrict: deleting any of them while a deal
 * points at it returns 409 rather than quietly destroying the deal.
 */
export const deals = pgTable(
  'deals',
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
    valueCents: bigint('value_cents', { mode: 'number' }),
    currency: text('currency'),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    expectedClose: date('expected_close'),
    competitors: text('competitors').array().notNull().default([]),
    risks: text('risks').notNull().default(''),
    whyWin: text('why_win').notNull().default(''),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    externalId: text('external_id'),
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
      { column: deals.name, weight: 'A' },
      { column: deals.risks, weight: 'B' },
      { column: deals.whyWin, weight: 'B' },
      { column: deals.summary, weight: 'B' },
      { column: deals.tags, weight: 'C', array: true },
      { column: deals.competitors, weight: 'C', array: true },
    ]),
  },
  (table) => [
    index('deals_workspace_idx').on(table.workspaceId),
    index('deals_company_idx').on(table.companyId),
    index('deals_stage_idx').on(table.stageId),
    index('deals_search_idx').using('gin', table.searchVector),
    check(
      'deals_converted_target_type_check',
      sql`${table.convertedTargetType} is null or ${oneOf('deals_converted_target_type_check', table.convertedTargetType, PIPELINE_KINDS)}`,
    ),
  ],
)

