import { z } from 'zod'

import {
  CUSTOM_FIELD_OBJECT_TYPES,
  CUSTOM_FIELD_TYPES,
} from './values.ts'
import type { CustomFieldObjectType, CustomFieldType } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/custom_fields`.
 *
 * The definition is workspace-scoped. Every record on the six object types
 * carries a `custom_fields` object keyed by definition key; the values are the
 * shape this file describes. The Zod layer here only checks structure — that a
 * value looks like text / number / boolean / a string list / a money object —
 * because the workspace's definitions are read from the database, not the
 * request. Definition-aware checks (this key exists on this object type, this
 * select value is one of the options) run in the service.
 *
 * Merge semantics on the record's `custom_fields` (documented in `api.md`): a
 * `PATCH` sends the keys that change; `null` clears a key; an unknown key is
 * `422` naming `custom_fields.<key>`.
 */

/**
 * The value union a custom field can carry on the wire. Structural only — the
 * validator in `@kelpie/server` reads the workspace's definitions and refuses a
 * `number` written into a `text` field, an unknown `select` option, and so on.
 *
 * `text`, `long_text`, `url`, `date` and `select` all serialise as strings; a
 * `multi_select` is a `string[]`; a `currency` is a small object; the rest are
 * primitives. Nothing here reads a definition, so the caps below are the
 * absolute ceilings meant to reject a runaway payload before it reaches the
 * database, not the per-type limits (also enforced by the validator).
 */
export const customFieldWireValue = z.union([
  z.string().max(65536),
  z.number(),
  z.boolean(),
  z.array(z.string().min(1).max(120)).max(100),
  z.strictObject({
    amount_cents: z.number().int(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
  }),
])

export type CustomFieldWireValue = z.infer<typeof customFieldWireValue>

/** A value already parsed and rebuilt as the record the UI holds. */
export type CustomFieldValue =
  | string
  | number
  | boolean
  | readonly string[]
  | { readonly amountCents: number; readonly currency: string }

/** The `custom_fields` object every record on the six object types carries. */
export type CustomFieldValues = Readonly<Record<string, CustomFieldValue>>

/**
 * Parses the wire object into the record shape the UI works with. Currency is
 * the one type that changes shape (`amount_cents` → `amountCents`); everything
 * else is the same value.
 */
export const customFieldValuesSchema: z.ZodType<CustomFieldValues, unknown> = z
  .record(z.string(), customFieldWireValue)
  .transform((wire): CustomFieldValues => {
    const out: Record<string, CustomFieldValue> = {}
    for (const [key, value] of Object.entries(wire)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        out[key] = { amountCents: value.amount_cents, currency: value.currency }
      } else {
        out[key] = value
      }
    }
    return out
  })

/**
 * The shape a record's `PATCH` accepts for `custom_fields`. A key's value is
 * the wire value, or `null` to clear that key; unknown keys fail at the service
 * layer with `422 custom_fields.<key>`.
 */
export const customFieldsPatchShape: z.ZodType<
  Readonly<Record<string, CustomFieldWireValue | null>>,
  unknown
> = z
  .record(z.string().min(1).max(64), customFieldWireValue.nullable())
  .describe(
    'Workspace-defined fields keyed by definition key. List the workspace\'s definitions with the custom_fields_list tool before writing. A key set to null clears the value; an unknown key is refused.',
  )

/**
 * Turns the UI's record shape back into the wire object for a `PATCH` body.
 * The inverse of `customFieldValuesSchema`.
 */
export function customFieldValuesBody(
  values: Readonly<Record<string, CustomFieldValue | null>>,
): Record<string, CustomFieldWireValue | null> {
  const out: Record<string, CustomFieldWireValue | null> = {}
  for (const [key, value] of Object.entries(values)) {
    out[key] = wireCustomFieldValue(value)
  }
  return out
}

function wireCustomFieldValue(value: CustomFieldValue | null): CustomFieldWireValue | null {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  // Array.isArray does not narrow a `readonly` array literal, so branch on the
  // currency object's shape and treat everything else as the string list.
  if ('amountCents' in value && 'currency' in value) {
    return { amount_cents: value.amountCents, currency: value.currency }
  }
  return [...value]
}

/** A workspace's definition of one custom field, for one object type. */
export interface CustomFieldDefinition extends RecordTimestamps {
  readonly id: string
  readonly objectType: CustomFieldObjectType
  /** Immutable after create. Lowercase snake_case, matches `/^[a-z][a-z0-9_]*$/`. */
  readonly key: string
  readonly label: string
  /** Immutable after create. */
  readonly type: CustomFieldType
  /** Non-empty only for `select` and `multi_select`. */
  readonly options: readonly string[]
  readonly description: string
  readonly sortOrder: number
}

export const customFieldDefinitionSchema: z.ZodType<CustomFieldDefinition, unknown> = z
  .object({
    id: idSchema,
    object_type: z.enum(CUSTOM_FIELD_OBJECT_TYPES),
    key: z.string(),
    label: z.string(),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(z.string()),
    description: z.string(),
    sort_order: z.number().int(),
    ...recordTimestamps,
  })
  .transform(
    (wire): CustomFieldDefinition => ({
      id: wire.id,
      objectType: wire.object_type,
      key: wire.key,
      label: wire.label,
      type: wire.type,
      options: wire.options,
      description: wire.description,
      sortOrder: wire.sort_order,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

/**
 * The body a create takes. `object_type`, `key`, and `type` are only written
 * here; a `PATCH` cannot change any of them (see `CustomFieldDefinitionInput`).
 */
export interface CreateCustomFieldDefinitionInput {
  readonly objectType: CustomFieldObjectType
  readonly key: string
  readonly label: string
  readonly type: CustomFieldType
  readonly options?: readonly string[]
  readonly description?: string
}

export function createCustomFieldDefinitionBody(
  input: CreateCustomFieldDefinitionInput,
): Record<string, unknown> {
  return definedFields({
    object_type: input.objectType,
    key: input.key,
    label: input.label,
    type: input.type,
    options: input.options,
    description: input.description,
  })
}

/**
 * What a `PATCH` may change. `key` and `type` are fixed for the definition's
 * lifetime — a change would strand records with the wrong value shape — and
 * the strict body naturally makes either a `422`.
 */
export interface CustomFieldDefinitionInput {
  readonly label?: string
  readonly options?: readonly string[]
  readonly description?: string
  readonly sortOrder?: number
}

export function customFieldDefinitionBody(
  input: CustomFieldDefinitionInput,
): Record<string, unknown> {
  return definedFields({
    label: input.label,
    options: input.options,
    description: input.description,
    sort_order: input.sortOrder,
  })
}
