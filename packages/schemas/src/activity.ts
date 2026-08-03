import { z } from 'zod'

import { ACTIVITY_KINDS, RECORD_TARGET_TYPES } from './values.ts'
import type { ActivityKind, RecordTargetType } from './values.ts'
import { idSchema, timestampSchema } from './wire.ts'

/**
 * Wire shape for `/v1/activities`. Read-only, so there is no body builder here.
 *
 * No `updatedAt`: the table is append-only and carries no such column.
 *
 * `actorLabel` is the display name to use when `actorMemberId` is null, e.g.
 * "Form", "Gmail", "API key". Exactly one of the two is set.
 */

export interface Activity {
  readonly id: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly kind: ActivityKind
  readonly actorMemberId: string | null
  readonly actorLabel: string | null
  readonly action: string
  readonly detail: string | null
  readonly createdAt: Date
}

export const activitySchema: z.ZodType<Activity, unknown> = z
  .object({
    id: idSchema,
    target_type: z.enum(RECORD_TARGET_TYPES),
    target_id: idSchema,
    kind: z.enum(ACTIVITY_KINDS),
    actor_member_id: idSchema.nullable(),
    actor_label: z.string().nullable(),
    action: z.string(),
    detail: z.string().nullable(),
    created_at: timestampSchema,
  })
  .transform(
    (wire): Activity => ({
      id: wire.id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      kind: wire.kind,
      actorMemberId: wire.actor_member_id,
      actorLabel: wire.actor_label,
      action: wire.action,
      detail: wire.detail,
      createdAt: wire.created_at,
    }),
  )
