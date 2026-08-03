import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { targetExists } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import * as repository from './repository.ts'
import { DEFAULT_ACTIVITY_SORT, ACTIVITY_SORTS } from './repository.ts'
import type { ActivityRecord } from './repository.ts'

/**
 * Activity: what happened, and who did it.
 *
 * Read-only. Rows are written by the services that make the change, through the
 * recorder, inside the same transaction (`recorder.ts`). There is deliberately
 * no create, update or delete route: a history a client can edit is not a
 * history, and `schema.md` gives the table no `updated_at` to support one.
 *
 * A timeline is not only the rows filed against the record. A person's timeline
 * includes the deals and partnerships they are on; a company's includes its
 * deals, opportunities and partnerships. The roll-up is resolved here rather
 * than in the browser, which is the point of moving `activitiesFor` server-side.
 */

export interface ActivitiesDependencies {
  readonly db: Database
}

/** An activity as the API returns one: the stored row minus the tenancy column. */
export type ActivityView = Omit<ActivityRecord, 'workspaceId'>

export interface ActivityTimelineQuery {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

export interface ActivitiesService {
  list(
    actor: Actor,
    timeline: ActivityTimelineQuery,
    query: ListQueryParameters,
  ): Promise<Page<ActivityView>>
}

function toView(record: ActivityRecord): ActivityView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

export function createActivitiesService(
  dependencies: ActivitiesDependencies,
): ActivitiesService {
  return {
    async list(actor, timeline, query) {
      const workspaceId = requireWorkspaceId(actor)

      // Without this an unknown id answers an empty timeline, which reads as
      // "nothing has happened" rather than "there is no such record".
      const exists = await targetExists(
        dependencies.db,
        workspaceId,
        timeline.targetType,
        timeline.targetId,
      )

      if (!exists) {
        throw AppError.notFound('Record not found')
      }

      const rolledUp = await repository.listRolledUpTargets(
        dependencies.db,
        workspaceId,
        timeline.targetType,
        timeline.targetId,
      )
      const window = readListWindow(query, ACTIVITY_SORTS, DEFAULT_ACTIVITY_SORT)
      const rows = await repository.listActivities(
        dependencies.db,
        workspaceId,
        [{ targetType: timeline.targetType, targetId: timeline.targetId }, ...rolledUp],
        window,
      )

      return mapPage(
        toPage(rows, window, (activity) => activity.id),
        toView,
      )
    },
  }
}
