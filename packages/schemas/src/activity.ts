import { z } from 'zod'

import { recordReferenceSchema } from './reference.ts'
import type { RecordReference } from './reference.ts'
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
 *
 * `targetName` names the record the row is filed on. A timeline rolls up rows
 * from related records, and a rolled-up row names where it came from. It is
 * null when the record no longer resolves.
 *
 * `references` are the records `detail` names by id. See `RecordReference`.
 */

export interface Activity {
  readonly id: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly targetName: string | null
  readonly kind: ActivityKind
  readonly actorMemberId: string | null
  readonly actorLabel: string | null
  readonly action: string
  readonly detail: string | null
  readonly references: readonly RecordReference[]
  /**
   * The record the row is about, when that is not the one it is filed on: the
   * note added, the company linked to, the form a deal came through. Named with
   * its current name; null when there is none or it no longer resolves.
   */
  readonly subject: RecordReference | null
  readonly createdAt: Date
}

export const activitySchema: z.ZodType<Activity, unknown> = z
  .object({
    id: idSchema,
    target_type: z.enum(RECORD_TARGET_TYPES),
    target_id: idSchema,
    target_name: z.string().nullable(),
    kind: z.enum(ACTIVITY_KINDS),
    actor_member_id: idSchema.nullable(),
    actor_label: z.string().nullable(),
    action: z.string(),
    detail: z.string().nullable(),
    references: z.array(recordReferenceSchema),
    subject: recordReferenceSchema.nullish(),
    created_at: timestampSchema,
  })
  .transform(
    (wire): Activity => ({
      id: wire.id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      targetName: wire.target_name,
      kind: wire.kind,
      actorMemberId: wire.actor_member_id,
      actorLabel: wire.actor_label,
      action: wire.action,
      detail: wire.detail,
      references: wire.references,
      subject: wire.subject ?? null,
      createdAt: wire.created_at,
    }),
  )
