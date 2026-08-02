import { index, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { checkOneOf, citext, createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The fixed value sets from `seed.ts`. Exported because the API validates against
 * these same arrays: a value the boundary accepts and the check constraint
 * refuses would be a 500 where a 422 belongs.
 */
export const COMPANY_STAGES = ['startup', 'growth', 'enterprise', 'other'] as const
export const SIZE_BANDS = ['1-10', '11-50', '51-200', '201+'] as const
export const ACCOUNT_TYPES = ['prospect', 'customer', 'partner', 'investor', 'other'] as const
export const ICP_FITS = ['high', 'medium', 'low', 'unknown'] as const

export type CompanyStage = (typeof COMPANY_STAGES)[number]
export type SizeBand = (typeof SIZE_BANDS)[number]
export type AccountType = (typeof ACCOUNT_TYPES)[number]
export type IcpFit = (typeof ICP_FITS)[number]

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
  },
  (table) => [
    unique('companies_workspace_domain_key').on(table.workspaceId, table.domain),
    index('companies_workspace_idx').on(table.workspaceId),
    checkOneOf('companies_stage_check', table.stage, COMPANY_STAGES),
    checkOneOf('companies_size_band_check', table.sizeBand, SIZE_BANDS),
    checkOneOf('companies_account_type_check', table.accountType, ACCOUNT_TYPES),
    checkOneOf('companies_icp_fit_check', table.icpFit, ICP_FITS),
  ],
)
