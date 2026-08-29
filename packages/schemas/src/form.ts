import { z } from 'zod'

import {
  FORM_FIELD_MAP_TARGETS,
  FORM_FIELD_TYPES,
  FORM_OPTION_VALUE_TYPES,
  FORM_STATUSES,
  PIPELINE_KINDS,
} from './values.ts'
import type {
  FormFieldMapTarget,
  FormFieldType,
  FormOptionValueType,
  FormStatus,
  PipelineKind,
} from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/forms`, the embeddable inbound capture from
 * [`forms.md`](../../../forms.md).
 *
 * Fields come back nested inside their form rather than as their own resource.
 * A form without its fields cannot be rendered or validated, so every caller
 * that wants one wants both, and the ordering is the form's rather than a
 * property of any single field.
 */

/**
 * A select choice. `key` is the identifier: it is what a stored answer holds and
 * what a submit is checked against, so the display `value` is free to change.
 */
export interface FormFieldOption {
  readonly key: string
  /** What the embed shows in the dropdown. */
  readonly value: string
  readonly valueType: FormOptionValueType
}

export interface FormField {
  readonly id: string
  readonly label: string
  readonly type: FormFieldType
  readonly required: boolean
  readonly mapTo: FormFieldMapTarget
  /** Empty for every type but `select`. */
  readonly options: readonly FormFieldOption[]
  readonly placeholder: string | null
  /** Position in the form, contiguous from 0. The server renumbers on every write. */
  readonly sortOrder: number
}

/**
 * One pre-existing pipeline record every submitter is linked into through
 * `person_links`. `target_type` is fixed at form-write time; the row itself
 * lives in `form_attach_targets` on the server.
 */
export interface FormAttachTarget {
  readonly targetType: PipelineKind
  readonly targetId: string
}

export interface Form extends RecordTimestamps {
  readonly id: string
  readonly name: string
  /**
   * Heading on the hosted/embed page. Defaults to `name` when the form is
   * created; edit it from Settings without renaming the form in the CRM.
   */
  readonly title: string
  readonly description: string | null
  readonly status: FormStatus
  readonly fields: readonly FormField[]
  readonly thankYouMessage: string
  readonly createDeal: boolean
  /** Null means the deal pipeline's default stage is used at submit time. */
  readonly dealStageId: string | null
  /** Expands `{{company.name}}` and `{{person.name}}`. Null when `createDeal` is off. */
  readonly dealNameTemplate: string | null
  readonly createOpportunity: boolean
  /** Required when `createOpportunity` is on: opportunities carry a `kind`. */
  readonly opportunityKind: string | null
  readonly opportunityStageId: string | null
  readonly opportunityNameTemplate: string | null
  /** Null falls back to the workspace default member at submit time. */
  readonly opportunityOwnerId: string | null
  readonly createPartnership: boolean
  /** Required when `createPartnership` is on. */
  readonly partnershipKind: string | null
  readonly partnershipStageId: string | null
  readonly partnershipNameTemplate: string | null
  /** Null falls back to the workspace default member at submit time. */
  readonly partnershipOwnerId: string | null
  /** Tags to merge (union) into the resolved Person's `tags` on every submit. */
  readonly personTags: readonly string[]
  /** Tags to merge (union) into the resolved Company's `tags`; skipped when no company resolved. */
  readonly companyTags: readonly string[]
  /** Lists (person or company) every matching record is added to on submit. */
  readonly listIds: readonly string[]
  /** Pre-existing pipeline records the submitter is linked to via `person_links`. */
  readonly attachTargets: readonly FormAttachTarget[]
  /**
   * The handle the public submit and embed endpoints resolve a workspace from.
   * Globally unique, and the only credential those endpoints take.
   */
  readonly publicKey: string
}

const formFieldOptionSchema = z
  .object({
    key: z.string(),
    value: z.string(),
    value_type: z.enum(FORM_OPTION_VALUE_TYPES),
  })
  .transform(
    (wire): FormFieldOption => ({
      key: wire.key,
      value: wire.value,
      valueType: wire.value_type,
    }),
  )

const formFieldSchema = z
  .object({
    id: idSchema,
    label: z.string(),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean(),
    map_to: z.enum(FORM_FIELD_MAP_TARGETS),
    options: z.array(formFieldOptionSchema),
    placeholder: z.string().nullable(),
    sort_order: z.number().int(),
  })
  .transform(
    (wire): FormField => ({
      id: wire.id,
      label: wire.label,
      type: wire.type,
      required: wire.required,
      mapTo: wire.map_to,
      options: wire.options,
      placeholder: wire.placeholder,
      sortOrder: wire.sort_order,
    }),
  )

const attachTargetSchema = z
  .object({
    target_type: z.enum(PIPELINE_KINDS),
    target_id: idSchema,
  })
  .transform(
    (wire): FormAttachTarget => ({
      targetType: wire.target_type,
      targetId: wire.target_id,
    }),
  )

export const formSchema: z.ZodType<Form, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(FORM_STATUSES),
    fields: z.array(formFieldSchema),
    thank_you_message: z.string(),
    create_deal: z.boolean(),
    deal_stage_id: idSchema.nullable(),
    deal_name_template: z.string().nullable(),
    create_opportunity: z.boolean(),
    opportunity_kind: z.string().nullable(),
    opportunity_stage_id: idSchema.nullable(),
    opportunity_name_template: z.string().nullable(),
    opportunity_owner_id: idSchema.nullable(),
    create_partnership: z.boolean(),
    partnership_kind: z.string().nullable(),
    partnership_stage_id: idSchema.nullable(),
    partnership_name_template: z.string().nullable(),
    partnership_owner_id: idSchema.nullable(),
    person_tags: z.array(z.string()),
    company_tags: z.array(z.string()),
    list_ids: z.array(idSchema),
    attach_targets: z.array(attachTargetSchema),
    public_key: z.string(),
    ...recordTimestamps,
  })
  .transform(
    (wire): Form => ({
      id: wire.id,
      name: wire.name,
      title: wire.title,
      description: wire.description,
      status: wire.status,
      fields: wire.fields,
      thankYouMessage: wire.thank_you_message,
      createDeal: wire.create_deal,
      dealStageId: wire.deal_stage_id,
      dealNameTemplate: wire.deal_name_template,
      createOpportunity: wire.create_opportunity,
      opportunityKind: wire.opportunity_kind,
      opportunityStageId: wire.opportunity_stage_id,
      opportunityNameTemplate: wire.opportunity_name_template,
      opportunityOwnerId: wire.opportunity_owner_id,
      createPartnership: wire.create_partnership,
      partnershipKind: wire.partnership_kind,
      partnershipStageId: wire.partnership_stage_id,
      partnershipNameTemplate: wire.partnership_name_template,
      partnershipOwnerId: wire.partnership_owner_id,
      personTags: wire.person_tags,
      companyTags: wire.company_tags,
      listIds: wire.list_ids,
      attachTargets: wire.attach_targets,
      publicKey: wire.public_key,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface FormFieldOptionInput {
  readonly key: string
  readonly value: string
  readonly valueType?: FormOptionValueType
}

/**
 * A field as it is written.
 *
 * There is no id: a write replaces the whole field list, so the server assigns
 * ids and positions from the array's order. Editing one field means sending the
 * list back with that field changed, which is also what a drag-reorder sends.
 */
export interface FormFieldInput {
  readonly label: string
  readonly type: FormFieldType
  readonly required?: boolean
  readonly mapTo: FormFieldMapTarget
  readonly options?: readonly FormFieldOptionInput[]
  readonly placeholder?: string | null
}

export interface CreateFormInput {
  readonly name: string
  /** Defaults to `name` when omitted. */
  readonly title?: string
  readonly description?: string | null
  readonly status?: FormStatus
  readonly fields: readonly FormFieldInput[]
  readonly thankYouMessage?: string
  readonly createDeal?: boolean
  readonly dealStageId?: string | null
  readonly dealNameTemplate?: string | null
  readonly createOpportunity?: boolean
  readonly opportunityKind?: string | null
  readonly opportunityStageId?: string | null
  readonly opportunityNameTemplate?: string | null
  readonly opportunityOwnerId?: string | null
  readonly createPartnership?: boolean
  readonly partnershipKind?: string | null
  readonly partnershipStageId?: string | null
  readonly partnershipNameTemplate?: string | null
  readonly partnershipOwnerId?: string | null
  readonly personTags?: readonly string[]
  readonly companyTags?: readonly string[]
  readonly listIds?: readonly string[]
  readonly attachTargets?: readonly FormAttachTarget[]
}

/**
 * `fields`, `list_ids`, and `attach_targets` are each absent or the whole list;
 * there is no per-entry patch.
 */
export interface FormInput {
  readonly name?: string
  readonly title?: string
  readonly description?: string | null
  readonly status?: FormStatus
  readonly fields?: readonly FormFieldInput[]
  readonly thankYouMessage?: string
  readonly createDeal?: boolean
  readonly dealStageId?: string | null
  readonly dealNameTemplate?: string | null
  readonly createOpportunity?: boolean
  readonly opportunityKind?: string | null
  readonly opportunityStageId?: string | null
  readonly opportunityNameTemplate?: string | null
  readonly opportunityOwnerId?: string | null
  readonly createPartnership?: boolean
  readonly partnershipKind?: string | null
  readonly partnershipStageId?: string | null
  readonly partnershipNameTemplate?: string | null
  readonly partnershipOwnerId?: string | null
  readonly personTags?: readonly string[]
  readonly companyTags?: readonly string[]
  readonly listIds?: readonly string[]
  readonly attachTargets?: readonly FormAttachTarget[]
}

function fieldBody(field: FormFieldInput): Record<string, unknown> {
  return definedFields({
    label: field.label,
    type: field.type,
    required: field.required,
    map_to: field.mapTo,
    options: field.options?.map((option) =>
      definedFields({ key: option.key, value: option.value, value_type: option.valueType }),
    ),
    placeholder: field.placeholder,
  })
}

function attachTargetBody(target: FormAttachTarget): Record<string, unknown> {
  return { target_type: target.targetType, target_id: target.targetId }
}

export function createFormBody(input: CreateFormInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    title: input.title,
    description: input.description,
    status: input.status,
    fields: input.fields.map(fieldBody),
    thank_you_message: input.thankYouMessage,
    create_deal: input.createDeal,
    deal_stage_id: input.dealStageId,
    deal_name_template: input.dealNameTemplate,
    create_opportunity: input.createOpportunity,
    opportunity_kind: input.opportunityKind,
    opportunity_stage_id: input.opportunityStageId,
    opportunity_name_template: input.opportunityNameTemplate,
    opportunity_owner_id: input.opportunityOwnerId,
    create_partnership: input.createPartnership,
    partnership_kind: input.partnershipKind,
    partnership_stage_id: input.partnershipStageId,
    partnership_name_template: input.partnershipNameTemplate,
    partnership_owner_id: input.partnershipOwnerId,
    person_tags: input.personTags,
    company_tags: input.companyTags,
    list_ids: input.listIds,
    attach_targets: input.attachTargets?.map(attachTargetBody),
  })
}

export function formBody(input: FormInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    title: input.title,
    description: input.description,
    status: input.status,
    fields: input.fields?.map(fieldBody),
    thank_you_message: input.thankYouMessage,
    create_deal: input.createDeal,
    deal_stage_id: input.dealStageId,
    deal_name_template: input.dealNameTemplate,
    create_opportunity: input.createOpportunity,
    opportunity_kind: input.opportunityKind,
    opportunity_stage_id: input.opportunityStageId,
    opportunity_name_template: input.opportunityNameTemplate,
    opportunity_owner_id: input.opportunityOwnerId,
    create_partnership: input.createPartnership,
    partnership_kind: input.partnershipKind,
    partnership_stage_id: input.partnershipStageId,
    partnership_name_template: input.partnershipNameTemplate,
    partnership_owner_id: input.partnershipOwnerId,
    person_tags: input.personTags,
    company_tags: input.companyTags,
    list_ids: input.listIds,
    attach_targets: input.attachTargets?.map(attachTargetBody),
  })
}
