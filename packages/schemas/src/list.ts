import { z } from 'zod'

import { RECORD_TARGET_TYPES } from './values.ts'
import type { RecordTargetType } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/lists`.
 *
 * A list holds records of one type. The type is chosen at creation and never
 * changes; a member added to it must match, and the database rejects a mismatch
 * with a composite foreign key rather than trusting the service to check.
 *
 * `memberCount` is a read-only rollup returned on list responses so an index
 * page can render totals without a follow-up call per row.
 */

export interface List extends RecordTimestamps {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly targetType: RecordTargetType
  readonly memberCount: number
  /**
   * The consent purpose captured when a form submit adds a person to this
   * list. Person lists only. Manual and API list adds capture nothing.
   */
  readonly consentPurposeId: string | null
  /** The named purpose's slug, denormalised so a reader needs no second call. */
  readonly consentPurposeSlug: string | null
}

export const listSchema: z.ZodType<List, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    description: z.string().nullable(),
    target_type: z.enum(RECORD_TARGET_TYPES),
    member_count: z.number().int().nonnegative(),
    consent_purpose_id: idSchema.nullable(),
    consent_purpose_slug: z.string().nullable(),
    ...recordTimestamps,
  })
  .transform(
    (wire): List => ({
      id: wire.id,
      name: wire.name,
      description: wire.description,
      targetType: wire.target_type,
      memberCount: wire.member_count,
      consentPurposeId: wire.consent_purpose_id,
      consentPurposeSlug: wire.consent_purpose_slug,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreateListInput {
  readonly name: string
  readonly targetType: RecordTargetType
  readonly description?: string | null
  /** Person lists only. `null` on a company list is fine; a non-null value is `422`. */
  readonly consentPurposeId?: string | null
}

export function createListBody(input: CreateListInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    target_type: input.targetType,
    description: input.description,
    consent_purpose_id: input.consentPurposeId,
  })
}

/** `targetType` is fixed for the life of a list, so it is not editable here. */
export interface ListInput {
  readonly name?: string
  readonly description?: string | null
  readonly consentPurposeId?: string | null
}

export function listBody(input: ListInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    description: input.description,
    consent_purpose_id: input.consentPurposeId,
  })
}
