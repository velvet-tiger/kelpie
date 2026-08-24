import { z } from 'zod'

import { RECORD_TARGET_TYPES } from './values.ts'
import type { RecordTargetType } from './values.ts'
import { idSchema, timestampSchema } from './wire.ts'

/**
 * "Which lists is this record on?" — a membership joined with its list.
 *
 * Returned by `GET /v1/list-memberships?target_type=X&target_id=Y`. The joined
 * list fields (`listName`, `listTargetType`) come along because a record's
 * detail page wants to render its chips without a follow-up call per list.
 */

export interface ListMembership {
  readonly id: string
  readonly listId: string
  readonly listName: string
  readonly listTargetType: RecordTargetType
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly addedAt: Date
}

export const listMembershipSchema: z.ZodType<ListMembership, unknown> = z
  .object({
    id: idSchema,
    list_id: idSchema,
    list_name: z.string(),
    list_target_type: z.enum(RECORD_TARGET_TYPES),
    target_type: z.enum(RECORD_TARGET_TYPES),
    target_id: idSchema,
    added_at: timestampSchema,
  })
  .transform(
    (wire): ListMembership => ({
      id: wire.id,
      listId: wire.list_id,
      listName: wire.list_name,
      listTargetType: wire.list_target_type,
      targetType: wire.target_type,
      targetId: wire.target_id,
      addedAt: wire.added_at,
    }),
  )
