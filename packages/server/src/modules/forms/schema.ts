import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { positions } from '../positions/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Embeddable inbound forms. `public_key` is globally unique because the public
 * submit endpoint resolves the workspace from it, with no credentials.
 */
export const forms = pgTable(
  'forms',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    thankYouMessage: text('thank_you_message').notNull().default(''),
    createDeal: boolean('create_deal').notNull().default(false),
    dealStageId: text('deal_stage_id').references(() => pipelineStages.id, { onDelete: 'restrict' }),
    dealNameTemplate: text('deal_name_template'),
    publicKey: text('public_key').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('forms_workspace_idx').on(table.workspaceId),
    check('forms_status_check', sql`${table.status} in ('active', 'paused')`),
  ],
)

/**
 * `map_to` decides what a field writes on submit. At most one `person.email`
 * mapping per form, enforced in the service layer because that is a per-form
 * rule, not a per-row one.
 */
export const formFields = pgTable(
  'form_fields',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    type: text('type').notNull(),
    required: boolean('required').notNull().default(false),
    mapTo: text('map_to').notNull(),
    options: jsonb('options').notNull().default([]),
    placeholder: text('placeholder'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('form_fields_form_idx').on(table.formId),
    check('form_fields_type_check', sql`${table.type} in ('text', 'email', 'textarea', 'select')`),
    check(
      'form_fields_map_to_check',
      sql`${table.mapTo} in ('person.name', 'person.email', 'company.name', 'company.domain', 'position.title', 'deal.name', 'submission')`,
    ),
  ],
)

/**
 * Record links are set null rather than cascade: a submission stays as evidence
 * of what arrived even after the record it created is deleted.
 */
export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    submittedAt: moment('submitted_at').notNull().defaultNow(),
    answers: jsonb('answers').notNull(),
    personId: text('person_id').references(() => people.id, { onDelete: 'set null' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
    positionId: text('position_id').references(() => positions.id, { onDelete: 'set null' }),
    dealId: text('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [index('form_submissions_form_idx').on(table.formId)],
)
