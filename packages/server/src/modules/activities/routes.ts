import type { Context, Hono } from 'hono'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { isRecordTargetType } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import type { ActivitiesService, ActivityView } from './service.ts'

/**
 * `/v1/activities`, read-only.
 *
 * One list endpoint, and it always names a record. A workspace-wide feed is a
 * different question with a different shape, and answering it accidentally
 * through an omitted filter is how a client ends up paging the entire history of
 * a workspace to render one sidebar.
 */

export interface ActivitiesRoutesDependencies extends CredentialDependencies {
  readonly service: ActivitiesService
}

export function activityResponse(activity: ActivityView): Record<string, unknown> {
  return {
    id: activity.id,
    target_type: activity.targetType,
    target_id: activity.targetId,
    kind: activity.kind,
    actor_member_id: activity.actorMemberId,
    actor_label: activity.actorLabel,
    action: activity.action,
    detail: activity.detail,
    created_at: activity.createdAt.toISOString(),
  }
}

/**
 * @throws AppError 422 when either half of the target is missing or the type is
 *   not one a record can be attached to.
 */
function readTarget(context: Context): { targetType: RecordTargetType; targetId: string } {
  const targetType = context.req.query('target_type')
  const targetId = context.req.query('target_id')

  if (targetType === undefined || targetId === undefined || targetId.length === 0) {
    throw AppError.validationFailed('A timeline is always a timeline of something', [
      { field: 'target_type', message: 'Required' },
      { field: 'target_id', message: 'Required' },
    ])
  }

  if (!isRecordTargetType(targetType)) {
    throw AppError.validationFailed('That is not a record type activity attaches to', [
      { field: 'target_type', message: `Unknown target type "${targetType}"` },
    ])
  }

  return { targetType, targetId }
}

export function mountActivitiesRoutes(
  router: Hono,
  dependencies: ActivitiesRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/activities', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      readTarget(context),
      readListParameters(context),
    )

    return context.json(pageBody(page, activityResponse))
  })
}
