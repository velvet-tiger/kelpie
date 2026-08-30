import { z } from 'zod'

import { customFieldValuesBody, customFieldValuesSchema } from './customField.ts'
import type { CustomFieldValue, CustomFieldValues } from './customField.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/deals`. */

export interface Deal extends RecordTimestamps {
  readonly id: string
  readonly name: string
  readonly companyId: string
  readonly stageId: string
  readonly valueCents: number | null
  readonly currency: string | null
  readonly ownerId: string | null
  /** `YYYY-MM-DD`, per `api.md` date-only fields. */
  readonly expectedClose: string | null
  readonly personIds: readonly string[]
  readonly competitors: readonly string[]
  readonly risks: string
  readonly whyWin: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly externalId: string | null
  /** Workspace-defined fields, keyed by definition key. Always present (default `{}`). */
  readonly customFields: CustomFieldValues
}

export const dealSchema: z.ZodType<Deal, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    company_id: idSchema,
    stage_id: idSchema,
    value_cents: z.number().int().nullable(),
    currency: z.string().nullable(),
    owner_id: idSchema.nullable(),
    expected_close: z.string().nullable(),
    person_ids: z.array(idSchema),
    competitors: z.array(z.string()),
    risks: z.string(),
    why_win: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
    external_id: z.string().nullable(),
    custom_fields: customFieldValuesSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Deal => ({
      id: wire.id,
      name: wire.name,
      companyId: wire.company_id,
      stageId: wire.stage_id,
      valueCents: wire.value_cents,
      currency: wire.currency,
      ownerId: wire.owner_id,
      expectedClose: wire.expected_close,
      personIds: wire.person_ids,
      competitors: wire.competitors,
      risks: wire.risks,
      whyWin: wire.why_win,
      summary: wire.summary,
      tags: wire.tags,
      externalId: wire.external_id,
      customFields: wire.custom_fields,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface DealInput {
  readonly name?: string
  readonly companyId?: string
  readonly stageId?: string
  readonly valueCents?: number | null
  readonly currency?: string | null
  readonly ownerId?: string | null
  readonly expectedClose?: string | null
  readonly personIds?: readonly string[]
  readonly competitors?: readonly string[]
  readonly risks?: string
  readonly whyWin?: string
  readonly summary?: string
  readonly tags?: readonly string[]
  readonly externalId?: string | null
  /**
   * Partial merge patch: sent keys change, `null` clears a key, absent keys are
   * left alone. Unknown keys are rejected at `422`.
   */
  readonly customFields?: Readonly<Record<string, CustomFieldValue | null>>
}

export function dealBody(input: DealInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    company_id: input.companyId,
    stage_id: input.stageId,
    value_cents: input.valueCents,
    currency: input.currency,
    owner_id: input.ownerId,
    expected_close: input.expectedClose,
    person_ids: input.personIds,
    competitors: input.competitors,
    risks: input.risks,
    why_win: input.whyWin,
    summary: input.summary,
    tags: input.tags,
    external_id: input.externalId,
    custom_fields:
      input.customFields === undefined ? undefined : customFieldValuesBody(input.customFields),
  })
}
