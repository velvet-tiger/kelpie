import { z } from 'zod'

import { convertedToWireSchema } from './conversion.ts'
import type { ConvertedTo } from './conversion.ts'
import { customFieldValuesBody, customFieldValuesSchema } from './customField.ts'
import type { CustomFieldValue, CustomFieldValues } from './customField.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/partnerships`. */

export interface Partnership extends RecordTimestamps {
  readonly id: string
  readonly name: string
  /** Required: a partnership is with an organisation, unlike an opportunity. */
  readonly companyId: string
  readonly stageId: string
  /** Free text ("Integration", "Co-marketing", …), not an enum: the seed's own kinds vary by workspace. */
  readonly kind: string
  /** `YYYY-MM-DD`, per `api.md` date-only fields. */
  readonly nextTouchpoint: string | null
  readonly ownerId: string | null
  readonly goals: string
  readonly successLooksLike: string
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  /** Non-null once this record has been converted to another pipeline type. */
  readonly convertedTo: ConvertedTo | null
  /** Workspace-defined fields, keyed by definition key. Always present (default `{}`). */
  readonly customFields: CustomFieldValues
}

export const partnershipSchema: z.ZodType<Partnership, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    company_id: idSchema,
    stage_id: idSchema,
    kind: z.string(),
    next_touchpoint: z.string().nullable(),
    owner_id: idSchema.nullable(),
    goals: z.string(),
    success_looks_like: z.string(),
    person_ids: z.array(idSchema),
    summary: z.string(),
    tags: z.array(z.string()),
    converted_to: convertedToWireSchema,
    custom_fields: customFieldValuesSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Partnership => ({
      id: wire.id,
      name: wire.name,
      companyId: wire.company_id,
      stageId: wire.stage_id,
      kind: wire.kind,
      nextTouchpoint: wire.next_touchpoint,
      ownerId: wire.owner_id,
      goals: wire.goals,
      successLooksLike: wire.success_looks_like,
      personIds: wire.person_ids,
      summary: wire.summary,
      tags: wire.tags,
      convertedTo:
        wire.converted_to === null
          ? null
          : { targetType: wire.converted_to.target_type, targetId: wire.converted_to.target_id },
      customFields: wire.custom_fields,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface PartnershipInput {
  readonly name?: string
  readonly companyId?: string
  readonly stageId?: string
  readonly kind?: string
  readonly nextTouchpoint?: string | null
  readonly ownerId?: string | null
  readonly goals?: string
  readonly successLooksLike?: string
  readonly personIds?: readonly string[]
  readonly summary?: string
  readonly tags?: readonly string[]
  /**
   * Partial merge patch: sent keys change, `null` clears a key, absent keys are
   * left alone. Unknown keys are rejected at `422`.
   */
  readonly customFields?: Readonly<Record<string, CustomFieldValue | null>>
}

export function partnershipBody(input: PartnershipInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    company_id: input.companyId,
    stage_id: input.stageId,
    kind: input.kind,
    next_touchpoint: input.nextTouchpoint,
    owner_id: input.ownerId,
    goals: input.goals,
    success_looks_like: input.successLooksLike,
    person_ids: input.personIds,
    summary: input.summary,
    tags: input.tags,
    custom_fields:
      input.customFields === undefined ? undefined : customFieldValuesBody(input.customFields),
  })
}
