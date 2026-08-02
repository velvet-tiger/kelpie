import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { citext, createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

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
    check('companies_stage_check', sql`${table.stage} in ('startup', 'growth', 'enterprise', 'other')`),
    check('companies_size_band_check', sql`${table.sizeBand} in ('1-10', '11-50', '51-200', '201+')`),
    check(
      'companies_account_type_check',
      sql`${table.accountType} in ('prospect', 'customer', 'partner', 'investor', 'other')`,
    ),
    check('companies_icp_fit_check', sql`${table.icpFit} in ('high', 'medium', 'low', 'unknown')`),
  ],
)
