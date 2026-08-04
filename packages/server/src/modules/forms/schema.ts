import { FORM_FIELD_MAP_TARGETS, FORM_FIELD_TYPES, FORM_STATUSES } from '@kelpie/schemas'
import type { FormOptionValueType } from '@kelpie/schemas'
import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { positions } from '../positions/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The fixed value sets come from `@kelpie/schemas`, so these tables' check
 * constraints, this module's Zod enums, and the browser's decoder are one list
 * rather than three copies. A value the boundary accepts and the check
 * constraint refuses would be a 500 where a 422 belongs.
 */
export {
  FORM_FIELD_MAP_TARGET_LABELS,
  FORM_FIELD_MAP_TARGETS,
  FORM_FIELD_TYPES,
  FORM_OPTION_VALUE_TYPES,
  FORM_STATUSES,
  PERSON_EMAIL_TARGET,
} from '@kelpie/schemas'
export type {
  FormFieldMapTarget,
  FormFieldType,
  FormOptionValueType,
  FormStatus,
} from '@kelpie/schemas'

/**
 * A select choice as it is stored.
 *
 * jsonb rather than a fourth table: nothing queries into an option, and the set
 * is only ever read, written, and replaced along with the field that owns it.
 * Typed rather than left as `unknown`, and the route layer parses what goes in,
 * so a row read back is the shape it claims to be.
 *
 * No id. `key` is what a stored answer holds and what a submit is validated
 * against, so it is already the handle; a second identifier would be one nothing
 * addresses and one more thing to keep unique.
 */
export interface StoredFormFieldOption {
  readonly key: string
  readonly value: string
  readonly valueType: FormOptionValueType
}

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
    checkOneOf('forms_status_check', table.status, FORM_STATUSES),
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
    options: jsonb('options').$type<readonly StoredFormFieldOption[]>().notNull().default([]),
    placeholder: text('placeholder'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('form_fields_form_idx').on(table.formId),
    checkOneOf('form_fields_type_check', table.type, FORM_FIELD_TYPES),
    checkOneOf('form_fields_map_to_check', table.mapTo, FORM_FIELD_MAP_TARGETS),
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
    answers: jsonb('answers').$type<Readonly<Record<string, string>>>().notNull(),
    personId: text('person_id').references(() => people.id, { onDelete: 'set null' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
    positionId: text('position_id').references(() => positions.id, { onDelete: 'set null' }),
    dealId: text('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [index('form_submissions_form_idx').on(table.formId)],
)
