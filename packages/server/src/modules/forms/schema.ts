import {
  DEFAULT_AUTO_REPLY_BODY,
  DEFAULT_AUTO_REPLY_SUBJECT,
  DEFAULT_NOTIFY_BODY,
  DEFAULT_NOTIFY_SUBJECT,
  FORM_ATTACH_TARGET_TYPES,
  FORM_EMAIL_KINDS,
  FORM_EMAIL_RECIPIENT_KINDS,
  FORM_EMAIL_SEND_STATUSES,
  FORM_FIELD_TYPES,
  FORM_STATUSES,
} from '@kelpie/schemas'
import type { FormOptionValueType, FormSubmissionActionEntry } from '@kelpie/schemas'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, moment, primaryId, searchVector, updatedAt } from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
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
 * Embeddable inbound forms. The public submit and embed URLs name the workspace
 * by id and the form by `slug`, so `slug` is unique per workspace only.
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
    /**
     * The emails a submit sends (`docs`: form emails). The recipients of the
     * notification are rows of `form_notify_recipients`. Templates are kept
     * while an email is off, so turning it off and on loses no text.
     */
    notifyEmail: boolean('notify_email').notNull().default(false),
    notifySubject: text('notify_subject').notNull().default(DEFAULT_NOTIFY_SUBJECT),
    notifyBody: text('notify_body').notNull().default(DEFAULT_NOTIFY_BODY),
    autoReply: boolean('auto_reply').notNull().default(false),
    autoReplySubject: text('auto_reply_subject').notNull().default(DEFAULT_AUTO_REPLY_SUBJECT),
    autoReplyBody: text('auto_reply_body').notNull().default(DEFAULT_AUTO_REPLY_BODY),
    /**
     * Where a reply to the auto-reply goes: a member, or a free-text address,
     * or neither (no Reply-To header). At most one is set; the service
     * writes both together. The member fk is `set null`, so removing that
     * member leaves an auto-reply with no Reply-To rather than blocking the
     * removal.
     */
    autoReplyReplyToMemberId: text('auto_reply_reply_to_member_id').references(
      () => workspaceMembers.id,
      { onDelete: 'set null' },
    ),
    autoReplyReplyToAddress: text('auto_reply_reply_to_address'),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: forms.name, weight: 'A' },
      { column: forms.title, weight: 'B' },
      { column: forms.description, weight: 'B' },
    ]),
  },
  (table) => [
    index('forms_workspace_idx').on(table.workspaceId),
    uniqueIndex('forms_workspace_slug_idx').on(table.workspaceId, table.slug),
    index('forms_search_idx').using('gin', table.searchVector),
    checkOneOf('forms_status_check', table.status, FORM_STATUSES),
    check(
      'forms_auto_reply_reply_to_check',
      sql`${table.autoReplyReplyToMemberId} is null or ${table.autoReplyReplyToAddress} is null`,
    ),
  ],
)

/**
 * Who the notification email goes to, in the order the builder shows them.
 *
 * A member row names a membership and resolves to its account email at send
 * time. The fk cascades: a member who leaves the workspace stops receiving the
 * notification, and the form keeps its other recipients. An address row is
 * free text. Exactly one of the two is set. No `id`: the rows never cross the
 * wire on their own, and a write replaces the whole list, like `form_lists`.
 */
export const formNotifyRecipients = pgTable(
  'form_notify_recipients',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    memberId: text('member_id').references(() => workspaceMembers.id, { onDelete: 'cascade' }),
    address: text('address'),
  },
  (table) => [
    primaryKey({ columns: [table.formId, table.position] }),
    index('form_notify_recipients_workspace_idx').on(table.workspaceId),
    index('form_notify_recipients_member_idx').on(table.memberId),
    checkOneOf('form_notify_recipients_kind_check', table.kind, FORM_EMAIL_RECIPIENT_KINDS),
    check(
      'form_notify_recipients_target_check',
      sql`(${table.kind} = 'member' and ${table.memberId} is not null and ${table.address} is null) or (${table.kind} = 'address' and ${table.address} is not null and ${table.memberId} is null)`,
    ),
  ],
)

/**
 * Lists (person or company) every matching record from a submit is added to.
 *
 * The pair `(form_id, list_id)` is the natural key. No `id`, because the row
 * never crosses the wire — the form body carries a `list_ids: [...]` array
 * and the service reconciles it by set-diff. Both fks cascade: deleting a
 * list drops the action from every form naming it, keeping the promise in
 * `docs/guides/forms.md` that a list delete is never blocked.
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
    checkOneOf('form_attach_targets_target_type_check', table.targetType, FORM_ATTACH_TARGET_TYPES),
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
    /**
     * The checkbox statement for a `consent` field — the intro sentence that
     * sits above the list of purpose checkboxes. `label` is the field's
     * heading; `statement` is what the visitor reads before ticking. Null for
     * every other type.
     */
    statement: text('statement'),
    /**
     * The workspace consent purposes a `consent` field offers, in the order
     * the visitor sees them. Required (non-empty) when `type === 'consent'`.
     * A `text[]` rather than a join table because the set is small (usually
     * one to three), always read whole, and never queried into; the service
     * validates each id against `consent_purposes` and refuses an unknown one
     * at 422, and the purposes module refuses to delete a purpose still
     * listed on any form field (`form_fields.consent_purpose_ids` scan).
     */
    consentPurposeIds: text('consent_purpose_ids')
      .array()
      .notNull()
      .default([]),
    /**
     * Optional per-purpose override for the text shown next to each checkbox.
     * Keyed by purpose id; absent keys fall back to the workspace purpose's
     * own label. Bound to the same purpose the checkbox grants — the map
     * changes wording, never which purpose is being consented to.
     */
    consentPurposeLabels: jsonb('consent_purpose_labels')
      .$type<Readonly<Record<string, string>>>()
      .notNull()
      .default({}),
    /**
     * The lists an "Add to list" (`list`) field offers, in the order the
     * visitor sees them. Required (non-empty) when `type === 'list'`. A
     * `text[]` for the same reason as `consent_purpose_ids`. The service
     * checks each id at write; deleting a list removes its id from every
     * field (the `lists.list.deleted` subscriber), and a submit skips an id
     * that no longer names a list.
     */
    listIds: text('list_ids').array().notNull().default([]),
    /**
     * Optional per-list override for the checkbox text, keyed by list id.
     * Absent keys fall back to the list's name.
     */
    listLabels: jsonb('list_labels')
      .$type<Readonly<Record<string, string>>>()
      .notNull()
      .default({}),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('form_fields_form_idx').on(table.formId),
    checkOneOf('form_fields_type_check', table.type, FORM_FIELD_TYPES),
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

/**
 * One row for each message a form's email job sent or tried to send.
 *
 * The unique key is what makes a retried job safe: a message with a `sent` row
 * is not sent again. The 24-hour auto-reply rule and the daily auto-reply
 * limit are both queries on this table, which is why it records `skipped`
 * rows too but only `sent` rows count toward either.
 *
 * `detail` is the reason for a skip or an error. A provider's error text is
 * shortened before it is stored, and it never carries credentials: the SMTP
 * module's own error message names the address and the reason only.
 */
export const formEmailSends = pgTable(
  'form_email_sends',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    submissionId: text('submission_id')
      .notNull()
      .references(() => formSubmissions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    recipient: text('recipient').notNull(),
    status: text('status').notNull(),
    detail: text('detail').notNull().default(''),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('form_email_sends_message_idx').on(table.submissionId, table.kind, table.recipient),
    index('form_email_sends_recent_idx').on(table.workspaceId, table.kind, table.createdAt),
    index('form_email_sends_recipient_idx').on(table.formId, table.kind, table.recipient),
    checkOneOf('form_email_sends_kind_check', table.kind, FORM_EMAIL_KINDS),
    checkOneOf('form_email_sends_status_check', table.status, FORM_EMAIL_SEND_STATUSES),
  ],
)
