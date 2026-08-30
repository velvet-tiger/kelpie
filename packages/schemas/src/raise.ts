import { z } from 'zod'

import { customFieldValuesBody, customFieldValuesSchema } from './customField.ts'
import type { CustomFieldValue, CustomFieldValues } from './customField.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/raises`. */

export interface Raise extends RecordTimestamps {
  readonly id: string
  readonly name: string
  /** Required: the firm. The ongoing investor relationship stays a Partnership. */
  readonly companyId: string
  readonly stageId: string
  readonly checkSizeCents: number | null
  readonly currency: string | null
  readonly thesisFit: string
  /** Why they said no. Meaningful whenever set, not only in the passed stage. */
  readonly passReason: string | null
  readonly ownerId: string | null
  /** `YYYY-MM-DD`, per `api.md` date-only fields. */
  readonly expectedClose: string | null
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  /** Workspace-defined fields, keyed by definition key. Always present (default `{}`). */
  readonly customFields: CustomFieldValues
}

export const raiseSchema: z.ZodType<Raise, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    company_id: idSchema,
    stage_id: idSchema,
    check_size_cents: z.number().int().nullable(),
    currency: z.string().nullable(),
    thesis_fit: z.string(),
    pass_reason: z.string().nullable(),
    owner_id: idSchema.nullable(),
    expected_close: z.string().nullable(),
    person_ids: z.array(idSchema),
    summary: z.string(),
    tags: z.array(z.string()),
    custom_fields: customFieldValuesSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Raise => ({
      id: wire.id,
      name: wire.name,
      companyId: wire.company_id,
      stageId: wire.stage_id,
      checkSizeCents: wire.check_size_cents,
      currency: wire.currency,
      thesisFit: wire.thesis_fit,
      passReason: wire.pass_reason,
      ownerId: wire.owner_id,
      expectedClose: wire.expected_close,
      personIds: wire.person_ids,
      summary: wire.summary,
      tags: wire.tags,
      customFields: wire.custom_fields,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface RaiseInput {
  readonly name?: string
  readonly companyId?: string
  readonly stageId?: string
  readonly checkSizeCents?: number | null
  readonly currency?: string | null
  readonly thesisFit?: string
  readonly passReason?: string | null
  readonly ownerId?: string | null
  readonly expectedClose?: string | null
  readonly personIds?: readonly string[]
  readonly summary?: string
  readonly tags?: readonly string[]
  /**
   * Partial merge patch: sent keys change, `null` clears a key, absent keys are
   * left alone. Unknown keys are rejected at `422`.
   */
  readonly customFields?: Readonly<Record<string, CustomFieldValue | null>>
}

export function raiseBody(input: RaiseInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    company_id: input.companyId,
    stage_id: input.stageId,
    check_size_cents: input.checkSizeCents,
    currency: input.currency,
    thesis_fit: input.thesisFit,
    pass_reason: input.passReason,
    owner_id: input.ownerId,
    expected_close: input.expectedClose,
    person_ids: input.personIds,
    summary: input.summary,
    tags: input.tags,
    custom_fields:
      input.customFields === undefined ? undefined : customFieldValuesBody(input.customFields),
  })
}
