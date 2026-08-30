import {
  FORM_FIELD_MAP_TARGETS,
  FORM_FIELD_TYPES,
  FORM_STATUSES,
  PIPELINE_KINDS,
} from '@kelpie/schemas'
import type { FormOptionValueType, FormSubmissionActionEntry } from '@kelpie/schemas'
import { boolean, index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { lists } from '../lists/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { positions } from '../positions/schema.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

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
 *
 * The opportunity/partnership trigger columns mirror the deal trigger: a
 * toggle, an optional stage (null → first open at submit), a required kind
 * while the toggle is on (enforced in the service, so a stage id from the
 * wrong pipeline can be rejected in the same 422 the deal path uses), a
 * template that expands `{{company.name}}` / `{{person.name}}`, and an owner
 * (null → workspace default member). Owner fks are `set null` on member
 * removal so the workspace can still delete a member who owns a form action.
 */
export const forms = pgTable(
  'forms',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * Heading shown on the hosted/embed page. Independent of `name` (the CRM
     * label); defaults to `name` at create time.
     */
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    thankYouMessage: text('thank_you_message').notNull().default(''),
    createDeal: boolean('create_deal').notNull().default(false),
    dealStageId: text('deal_stage_id').references(() => pipelineStages.id, { onDelete: 'restrict' }),
    dealNameTemplate: text('deal_name_template'),
    createOpportunity: boolean('create_opportunity').notNull().default(false),
    opportunityKind: text('opportunity_kind'),
    opportunityStageId: text('opportunity_stage_id').references(() => pipelineStages.id, {
      onDelete: 'restrict',
    }),
    opportunityNameTemplate: text('opportunity_name_template'),
    opportunityOwnerId: text('opportunity_owner_id').references(() => workspaceMembers.id, {
      onDelete: 'set null',
    }),
    createPartnership: boolean('create_partnership').notNull().default(false),
    partnershipKind: text('partnership_kind'),
    partnershipStageId: text('partnership_stage_id').references(() => pipelineStages.id, {
      onDelete: 'restrict',
    }),
    partnershipNameTemplate: text('partnership_name_template'),
    partnershipOwnerId: text('partnership_owner_id').references(() => workspaceMembers.id, {
      onDelete: 'set null',
    }),
    createEnquiry: boolean('create_enquiry').notNull().default(false),
    /**
     * Optional free-text `source` written onto every enquiry the form creates
     * (e.g. "Website contact"). Enquiries have no `kind` so there is no
     * required-kind rule — an unset source stores empty on the enquiry.
     */
    enquirySource: text('enquiry_source'),
    enquiryStageId: text('enquiry_stage_id').references(() => pipelineStages.id, {
      onDelete: 'restrict',
    }),
    enquiryNameTemplate: text('enquiry_name_template'),
    enquiryOwnerId: text('enquiry_owner_id').references(() => workspaceMembers.id, {
      onDelete: 'set null',
    }),
    personTags: text('person_tags').array().notNull().default([]),
    companyTags: text('company_tags').array().notNull().default([]),
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
 * Lists (person or company) every matching record from a submit is added to.
 *
 * The pair `(form_id, list_id)` is the natural key. No `id`, because the row
 * never crosses the wire — the form body carries a `list_ids: [...]` array
 * and the service reconciles it by set-diff. Both fks cascade: deleting a
 * list drops the action from every form naming it, keeping the promise in
 * `lists.md` that a list delete is never blocked.
 */
export const formLists = pgTable(
  'form_lists',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.formId, table.listId] }),
    index('form_lists_workspace_idx').on(table.workspaceId),
  ],
)

/**
 * Pre-existing pipeline records every submitter is linked to via
 * `person_links`. Polymorphic per the convention notes/lists/plans/person_links
 * use: no fk to the target, existence checked by the service, rows removed in
 * the target's own delete transaction (`attachedRecords.ts`). No `id` — the
 * triple already identifies a row and the wire carries `attach_targets`
 * nested in the form body.
 */
export const formAttachTargets = pgTable(
  'form_attach_targets',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.formId, table.targetType, table.targetId] }),
    index('form_attach_targets_target_idx').on(
      table.workspaceId,
      table.targetType,
      table.targetId,
    ),
    checkOneOf('form_attach_targets_target_type_check', table.targetType, PIPELINE_KINDS),
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
 *
 * `action_log` is one entry per post-submit action attempted, in order. Empty
 * for a form with no post-actions configured, and empty on a legacy row from
 * before the column existed (the migration defaults it). Persisted so the
 * Submissions UI and API readers see what ran, what was skipped, and what
 * rolled back.
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
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    partnershipId: text('partnership_id').references(() => partnerships.id, {
      onDelete: 'set null',
    }),
    enquiryId: text('enquiry_id').references(() => enquiries.id, { onDelete: 'set null' }),
    actionLog: jsonb('action_log')
      .$type<readonly FormSubmissionActionEntry[]>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
  },
  (table) => [index('form_submissions_form_idx').on(table.formId)],
)
