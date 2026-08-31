import { z } from 'zod'

import { CONSENT_PURPOSE_STATUSES } from './values.ts'
import type { ConsentPurposeStatus } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/consent_purposes`.
 *
 * A workspace defines its own purposes (`contact`, `marketing`, …). Every
 * capture site — forms, lists, imports, the manual override on a Person —
 * names one. Modelled on `custom_field_definitions`: `slug` is immutable and
 * behaves as the key, `default_status` is the workspace default a person
 * without an explicit `person_consents` row inherits, and `sort_order` runs
 * 0..N-1 with the service renumbering on reorder and delete.
 */

/** A workspace's definition of one consent purpose. */
export interface ConsentPurpose extends RecordTimestamps {
  readonly id: string
  /** Immutable after create. Lowercase snake_case, matches `/^[a-z][a-z0-9_]*$/`. */
  readonly slug: string
  readonly label: string
  readonly description: string
  /** The workspace default a person without an explicit row inherits. */
  readonly defaultStatus: ConsentPurposeStatus
  readonly sortOrder: number
}

export const consentPurposeSchema: z.ZodType<ConsentPurpose, unknown> = z
  .object({
    id: idSchema,
    slug: z.string(),
    label: z.string(),
    description: z.string(),
    default_status: z.enum(CONSENT_PURPOSE_STATUSES),
    sort_order: z.number().int(),
    ...recordTimestamps,
  })
  .transform(
    (wire): ConsentPurpose => ({
      id: wire.id,
      slug: wire.slug,
      label: wire.label,
      description: wire.description,
      defaultStatus: wire.default_status,
      sortOrder: wire.sort_order,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

/**
 * The body a create takes. `slug` is only written here; a `PATCH` cannot
 * change it — a rename would strand every stored `person_consents` row and
 * every form/list/import that names the purpose.
 */
export interface CreateConsentPurposeInput {
  readonly slug: string
  readonly label: string
  readonly description?: string
  readonly defaultStatus?: ConsentPurposeStatus
}

export function createConsentPurposeBody(
  input: CreateConsentPurposeInput,
): Record<string, unknown> {
  return definedFields({
    slug: input.slug,
    label: input.label,
    description: input.description,
    default_status: input.defaultStatus,
  })
}

/**
 * What a `PATCH` may change. `slug` is fixed for the purpose's lifetime and
 * the strict body naturally makes it a `422`.
 */
export interface ConsentPurposeInput {
  readonly label?: string
  readonly description?: string
  readonly defaultStatus?: ConsentPurposeStatus
  readonly sortOrder?: number
}

export function consentPurposeBody(input: ConsentPurposeInput): Record<string, unknown> {
  return definedFields({
    label: input.label,
    description: input.description,
    default_status: input.defaultStatus,
    sort_order: input.sortOrder,
  })
}
