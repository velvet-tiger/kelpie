import { z } from 'zod'

import { EVENT_ASSOCIATION_TARGET_TYPES } from './values.ts'
import type { EventAssociationTargetType } from './values.ts'
import { idSchema } from './wire.ts'

/**
 * One Event linked to another record, as returned by
 * `GET /v1/event-associations?target_type=&target_id=`.
 *
 * The Event's own `associations` array is the forward view. This is the reverse
 * tab on a Deal, Company, Role, and so on.
 */

export interface EventAssociationRow {
  readonly eventId: string
  readonly eventName: string
  readonly targetType: EventAssociationTargetType
  readonly targetId: string
}

export const eventAssociationRowSchema: z.ZodType<EventAssociationRow, unknown> = z
  .object({
    event_id: idSchema,
    event_name: z.string(),
    target_type: z.enum(EVENT_ASSOCIATION_TARGET_TYPES),
    target_id: idSchema,
  })
  .transform(
    (wire): EventAssociationRow => ({
      eventId: wire.event_id,
      eventName: wire.event_name,
      targetType: wire.target_type,
      targetId: wire.target_id,
    }),
  )
