import { activitySchema } from '@kelpie/schemas'
import type { Activity, RecordTargetType } from '@kelpie/schemas'

import { createReadOnlyResourceHooks } from '../resource.ts'
import type { RecordListResult } from '../resource.ts'
import type { QueryParameters } from '../client.ts'

/**
 * `/v1/activities`, read-only.
 *
 * No write hooks, because the API has no write routes: activity is emitted by
 * the service that made the change, in the same transaction, and the table is
 * append-only.
 *
 * The roll-up a person's or company's timeline shows is resolved server-side.
 * Nothing here fetches related deals to merge them in.
 */

const activities = createReadOnlyResourceHooks<Activity>({
  name: 'activities',
  path: '/activities',
  decode: activitySchema.parse,
})

export interface ActivityTimeline {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

export function useActivities(
  timeline: ActivityTimeline,
  query?: QueryParameters,
): RecordListResult<Activity> {
  return activities.useList({
    target_type: timeline.targetType,
    target_id: timeline.targetId,
    ...query,
  })
}
