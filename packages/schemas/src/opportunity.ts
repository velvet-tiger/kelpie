import { z } from 'zod'

import { customFieldValuesBody, customFieldValuesSchema } from './customField.ts'
import type { CustomFieldValue, CustomFieldValues } from './customField.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/opportunities`. */

export interface Opportunity extends RecordTimestamps {
  readonly id: string
  readonly name: string
  /** Free text ("Grant", "Accelerator", …), not an enum: the seed's own kinds vary by workspace. */
  readonly kind: string
  readonly stageId: string
  /** Nullable: a speaking slot or a grant need not belong to a company on file. */
  readonly companyId: string | null
  readonly ownerId: string | null
  /** `YYYY-MM-DD`, per `api.md` date-only fields. */
  readonly expectedClose: string | null
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  /** Workspace-defined fields, keyed by definition key. Always present (default `{}`). */
  readonly customFields: CustomFieldValues
}

export const opportunitySchema: z.ZodType<Opportunity, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    kind: z.string(),
    stage_id: idSchema,
    company_id: idSchema.nullable(),
    owner_id: idSchema.nullable(),
    expected_close: z.string().nullable(),
    person_ids: z.array(idSchema),
    summary: z.string(),
    tags: z.array(z.string()),
    custom_fields: customFieldValuesSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Opportunity => ({
      id: wire.id,
      name: wire.name,
      kind: wire.kind,
      stageId: wire.stage_id,
      companyId: wire.company_id,
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

export interface OpportunityInput {
  readonly name?: string
  readonly kind?: string
  readonly stageId?: string
  readonly companyId?: string | null
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

export function opportunityBody(input: OpportunityInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    kind: input.kind,
    stage_id: input.stageId,
    company_id: input.companyId,
    owner_id: input.ownerId,
    expected_close: input.expectedClose,
    person_ids: input.personIds,
    summary: input.summary,
    tags: input.tags,
    custom_fields:
      input.customFields === undefined ? undefined : customFieldValuesBody(input.customFields),
  })
}
