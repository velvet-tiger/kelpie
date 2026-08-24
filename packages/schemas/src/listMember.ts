import { z } from 'zod'

import { RECORD_TARGET_TYPES } from './values.ts'
import type { RecordTargetType } from './values.ts'
import { definedFields, idSchema, timestampSchema } from './wire.ts'

/**
 * Wire and write shapes for `/v1/lists/:id/members`.
 *
 * A membership carries no state of its own: adding or removing a record is the
 * only edit. `targetName` is resolved server-side via `resolveTargetNames` so a
 * heterogeneous members table can render without an N+1.
 */

export interface ListMember {
  readonly id: string
  readonly listId: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly targetName: string | null
  readonly addedAt: Date
}

export const listMemberSchema: z.ZodType<ListMember, unknown> = z
  .object({
    id: idSchema,
    list_id: idSchema,
    target_type: z.enum(RECORD_TARGET_TYPES),
    target_id: idSchema,
    target_name: z.string().nullable(),
    added_at: timestampSchema,
  })
  .transform(
    (wire): ListMember => ({
      id: wire.id,
      listId: wire.list_id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      targetName: wire.target_name,
      addedAt: wire.added_at,
    }),
  )

export interface AddListMemberInput {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

export function addListMemberBody(input: AddListMemberInput): Record<string, unknown> {
  return definedFields({
    target_type: input.targetType,
    target_id: input.targetId,
  })
}
