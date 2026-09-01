import { z } from 'zod'

import { convertedToWireSchema } from './conversion.ts'
import type { ConvertedTo } from './conversion.ts'
import { customFieldValuesBody, customFieldValuesSchema } from './customField.ts'
import type { CustomFieldValue, CustomFieldValues } from './customField.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/enquiries`. */

export interface Enquiry extends RecordTimestamps {
  readonly id: string
  readonly name: string
  /** Free text ("Website", "Email", "Referral", …), like Opportunity's `kind`. */
  readonly source: string
  readonly stageId: string
  /** Nullable: an early enquiry may arrive before a company is on file. */
  readonly companyId: string | null
  readonly ownerId: string | null
  /** Non-null once the enquiry has been converted to a Deal; nulled if that deal is deleted. */
  readonly convertedDealId: string | null
  /** Non-null once this record has been converted to another pipeline type. */
  readonly convertedTo: ConvertedTo | null
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  /** Workspace-defined fields, keyed by definition key. Always present (default `{}`). */
  readonly customFields: CustomFieldValues
}

export const enquirySchema: z.ZodType<Enquiry, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    source: z.string(),
    stage_id: idSchema,
    company_id: idSchema.nullable(),
    owner_id: idSchema.nullable(),
    converted_deal_id: idSchema.nullable(),
    converted_to: convertedToWireSchema,
    person_ids: z.array(idSchema),
    summary: z.string(),
    tags: z.array(z.string()),
    custom_fields: customFieldValuesSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Enquiry => ({
      id: wire.id,
      name: wire.name,
      source: wire.source,
      stageId: wire.stage_id,
      companyId: wire.company_id,
      ownerId: wire.owner_id,
      convertedDealId: wire.converted_deal_id,
      convertedTo:
        wire.converted_to === null
          ? null
          : { targetType: wire.converted_to.target_type, targetId: wire.converted_to.target_id },
      personIds: wire.person_ids,
      summary: wire.summary,
      tags: wire.tags,
      customFields: wire.custom_fields,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

/**
 * `convertedDealId` is deliberately absent from the input: it is set only by
 * `POST /v1/enquiries/:id/convert`, and a `PATCH` that carried it is `422`.
 */
export interface EnquiryInput {
  readonly name?: string
  readonly source?: string
  readonly stageId?: string
  readonly companyId?: string | null
  readonly ownerId?: string | null
  readonly personIds?: readonly string[]
  readonly summary?: string
  readonly tags?: readonly string[]
  /**
   * Partial merge patch: sent keys change, `null` clears a key, absent keys are
   * left alone. Unknown keys are rejected at `422`.
   */
  readonly customFields?: Readonly<Record<string, CustomFieldValue | null>>
}

export function enquiryBody(input: EnquiryInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    source: input.source,
    stage_id: input.stageId,
    company_id: input.companyId,
    owner_id: input.ownerId,
    person_ids: input.personIds,
    summary: input.summary,
    tags: input.tags,
    custom_fields:
      input.customFields === undefined ? undefined : customFieldValuesBody(input.customFields),
  })
}
