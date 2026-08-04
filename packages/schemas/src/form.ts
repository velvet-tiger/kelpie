import { z } from 'zod'

import {
  FORM_FIELD_MAP_TARGETS,
  FORM_FIELD_TYPES,
  FORM_OPTION_VALUE_TYPES,
  FORM_STATUSES,
} from './values.ts'
import type { FormFieldMapTarget, FormFieldType, FormOptionValueType, FormStatus } from './values.ts'
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

export interface Form extends RecordTimestamps {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly status: FormStatus
  readonly fields: readonly FormField[]
  readonly thankYouMessage: string
  readonly createDeal: boolean
  /** Null means the deal pipeline's default stage is used at submit time. */
  readonly dealStageId: string | null
  /** Expands `{{company.name}}` and `{{person.name}}`. Null when `createDeal` is off. */
  readonly dealNameTemplate: string | null
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

export const formSchema: z.ZodType<Form, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(FORM_STATUSES),
    fields: z.array(formFieldSchema),
    thank_you_message: z.string(),
    create_deal: z.boolean(),
    deal_stage_id: idSchema.nullable(),
    deal_name_template: z.string().nullable(),
    public_key: z.string(),
    ...recordTimestamps,
  })
  .transform(
    (wire): Form => ({
      id: wire.id,
      name: wire.name,
      description: wire.description,
      status: wire.status,
      fields: wire.fields,
      thankYouMessage: wire.thank_you_message,
      createDeal: wire.create_deal,
      dealStageId: wire.deal_stage_id,
      dealNameTemplate: wire.deal_name_template,
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
  readonly description?: string | null
  readonly status?: FormStatus
  readonly fields: readonly FormFieldInput[]
  readonly thankYouMessage?: string
  readonly createDeal?: boolean
  readonly dealStageId?: string | null
  readonly dealNameTemplate?: string | null
}

/** `fields` is absent or the whole list; there is no per-field patch. */
export interface FormInput {
  readonly name?: string
  readonly description?: string | null
  readonly status?: FormStatus
  readonly fields?: readonly FormFieldInput[]
  readonly thankYouMessage?: string
  readonly createDeal?: boolean
  readonly dealStageId?: string | null
  readonly dealNameTemplate?: string | null
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

export function createFormBody(input: CreateFormInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    description: input.description,
    status: input.status,
    fields: input.fields.map(fieldBody),
    thank_you_message: input.thankYouMessage,
    create_deal: input.createDeal,
    deal_stage_id: input.dealStageId,
    deal_name_template: input.dealNameTemplate,
  })
}

export function formBody(input: FormInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    description: input.description,
    status: input.status,
    fields: input.fields?.map(fieldBody),
    thank_you_message: input.thankYouMessage,
    create_deal: input.createDeal,
    deal_stage_id: input.dealStageId,
    deal_name_template: input.dealNameTemplate,
  })
}
