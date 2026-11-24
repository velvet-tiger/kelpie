import { z } from 'zod'

import { idSchema, timestampSchema } from './wire.ts'

/**
 * Wire shape for `GET /v1/lists/:id/stats`: a read-only summary of one list.
 *
 * The figures cover every member of the list, not one page of them.
 * `addedLast30Days` counts members whose `added_at` falls in the 30 days
 * before the server answered. `lastAddedAt` is null for an empty list.
 */

export interface ListStats {
  readonly listId: string
  readonly memberCount: number
  readonly addedLast30Days: number
  readonly lastAddedAt: Date | null
}

export const listStatsSchema: z.ZodType<ListStats, unknown> = z
  .object({
    list_id: idSchema,
    member_count: z.number().int().nonnegative(),
    added_last_30_days: z.number().int().nonnegative(),
    last_added_at: timestampSchema.nullable(),
  })
  .transform(
    (wire): ListStats => ({
      listId: wire.list_id,
      memberCount: wire.member_count,
      addedLast30Days: wire.added_last_30_days,
      lastAddedAt: wire.last_added_at,
    }),
  )
