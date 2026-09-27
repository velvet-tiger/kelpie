import { isRecordReferenceType } from '@kelpie/schemas'
import type { RecordReference } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { referenceTo, resolveReferences } from '../recordReferences.ts'
import type { ReferenceTarget } from '../recordReferences.ts'
import { isRecordTargetType, targetExists, targetKey } from '../recordTargets.ts'
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
 * history, and the table has no `updated_at` to support one.
 *
 * A timeline is not only the rows filed against the record. A person's timeline
 * includes the deals and partnerships they are on; a company's includes its
 * deals, opportunities and partnerships. The roll-up is resolved here rather
 * than in the browser, which is the point of moving `activitiesFor` server-side.
 */

export interface ActivitiesDependencies {
  readonly db: Database
}

/**
 * An activity as the API returns one: the stored row minus the tenancy column,
 * plus the name of the record it is filed on and the records its detail cites.
 */
export type ActivityView = Omit<ActivityRecord, 'workspaceId'> & {
  readonly targetName: string | null
  readonly references: readonly RecordReference[]
  /** The record the row is about, named, or null when there is none or it is gone. */
  readonly subject: RecordReference | null
}

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

/** A row's subject as a target to name, when it has one of a known type. */
function subjectOf(record: ActivityRecord): readonly ReferenceTarget[] {
  return record.subjectType !== null &&
    record.subjectId !== null &&
    isRecordReferenceType(record.subjectType)
    ? [{ targetType: record.subjectType, targetId: record.subjectId }]
    : []
}

/**
 * Names the page's rows in one lookup: each row's own record, for a rolled-up
 * row's "on Partnership · Sandbox", its subject, and every record id its detail
 * cites.
 */
async function toViews(
  db: Database,
  workspaceId: string,
  records: readonly ActivityRecord[],
): Promise<ActivityView[]> {
  const { names, resolved, referencesIn } = await resolveReferences(
    db,
    workspaceId,
    records.map((record) => record.detail),
    records.flatMap((record): readonly ReferenceTarget[] => [
      ...(isRecordTargetType(record.targetType)
        ? [{ targetType: record.targetType, targetId: record.targetId }]
        : []),
      ...subjectOf(record),
    ]),
  )

  return records.map((record) => {
    const { workspaceId: _workspaceId, ...view } = record
    const targetName = isRecordTargetType(record.targetType)
      ? (names.get(targetKey({ targetType: record.targetType, targetId: record.targetId })) ??
        null)
      : null

    return {
      ...view,
      targetName,
      references: referencesIn(record.detail),
      subject: referenceTo(resolved, record.subjectType, record.subjectId),
    }
  })
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

      const page = toPage(rows, window, (activity) => activity.id)

      return {
        items: await toViews(dependencies.db, workspaceId, page.items),
        nextCursor: page.nextCursor,
      }
    },
  }
}
