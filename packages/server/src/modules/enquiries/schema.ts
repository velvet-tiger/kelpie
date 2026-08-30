import type { CustomFieldValue } from '@kelpie/schemas'
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, searchVector, updatedAt } from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

/**
 * Enquiries: the top-of-funnel pipeline. An inbound request — website form,
 * email, referral — that may become a Deal once qualified.
 *
 * `source` is free text like Opportunity's `kind`; a form is a source, and the
 * kinds a workspace uses vary. `company_id` is nullable because an early
 * enquiry may arrive before a company is on file. `converted_deal_id` becomes
 * non-null when the enquiry is converted via
 * `POST /v1/enquiries/:id/convert`; deleting the deal nulls it back so a
 * fresh conversion is possible.
 */
export const enquiries = pgTable(
  'enquiries',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    source: text('source').notNull().default(''),
    stageId: text('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    convertedDealId: text('converted_deal_id').references(() => deals.id, { onDelete: 'set null' }),
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
      { column: enquiries.name, weight: 'A' },
      { column: enquiries.source, weight: 'B' },
      { column: enquiries.summary, weight: 'B' },
      { column: enquiries.tags, weight: 'C', array: true },
    ]),
  },
  (table) => [
    index('enquiries_workspace_idx').on(table.workspaceId),
    index('enquiries_stage_idx').on(table.stageId),
    index('enquiries_converted_deal_idx').on(table.convertedDealId),
    index('enquiries_search_idx').using('gin', table.searchVector),
  ],
)
