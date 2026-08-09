import { ACCOUNT_TYPES, COMPANY_STAGES, ICP_FITS, SIZE_BANDS } from '@kelpie/schemas'
import { index, pgTable, text, unique } from 'drizzle-orm/pg-core'

import {
  checkOneOf,
  citext,
  createdAt,
  primaryId,
  searchVector,
  updatedAt,
} from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The fixed value sets come from `@kelpie/schemas`, so this table's check
 * constraints, this module's Zod enums, and the browser's decoder are one list
 * rather than three copies. A value the boundary accepts and the check
 * constraint refuses would be a 500 where a 422 belongs.
 */
export { ACCOUNT_TYPES, COMPANY_STAGES, ICP_FITS, SIZE_BANDS } from '@kelpie/schemas'
export type { AccountType, CompanyStage, IcpFit, SizeBand } from '@kelpie/schemas'

/** Organisations. `domain` is normalised (no scheme, no path) and compared case-insensitively. */
export const companies = pgTable(
  'companies',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: citext('domain'),
    industry: text('industry'),
    description: text('description').notNull().default(''),
    stage: text('stage').notNull(),
    sizeBand: text('size_band').notNull(),
    hq: text('hq'),
    website: text('website'),
    accountType: text('account_type').notNull(),
    icpFit: text('icp_fit').notNull(),
    techStack: text('tech_stack').array().notNull().default([]),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: companies.name, weight: 'A' },
      { column: companies.domain, weight: 'B' },
      { column: companies.industry, weight: 'B' },
      { column: companies.description, weight: 'B' },
      { column: companies.summary, weight: 'B' },
      { column: companies.tags, weight: 'C', array: true },
      { column: companies.techStack, weight: 'C', array: true },
    ]),
  },
  (table) => [
    unique('companies_workspace_domain_key').on(table.workspaceId, table.domain),
    index('companies_workspace_idx').on(table.workspaceId),
    index('companies_search_idx').using('gin', table.searchVector),
    checkOneOf('companies_stage_check', table.stage, COMPANY_STAGES),
    checkOneOf('companies_size_band_check', table.sizeBand, SIZE_BANDS),
    checkOneOf('companies_account_type_check', table.accountType, ACCOUNT_TYPES),
    checkOneOf('companies_icp_fit_check', table.icpFit, ICP_FITS),
  ],
)
