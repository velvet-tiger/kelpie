import type { IdFactory } from '../../lib/ids.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { actorMemberId } from '../auth/actor.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import * as repository from './repository.ts'
import type { ActivityKind } from './schema.ts'
import type { ActivityWording } from './wording.ts'

/**
 * How a service writes history.
 *
 * The write goes through the caller's transaction, not through the event bus.
 * The bus publishes after commit and its publication is not awaited
 * (`runtime/events.ts`), which is right for a webhook and wrong for this: an
 * activity is the record of what happened, so a change that commits while its
 * activity is lost leaves a timeline that quietly disagrees with the data. Same
 * transaction means both land or neither does.
 *
 * Services take this as a dependency rather than importing the repository, so a
 * service can be built with a recorder that collects instead of writing.
 */

/** What happened, minus who did it and when. */
export interface ActivityDraft extends ActivityWording {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly kind: ActivityKind
}

/**
 * @param workspaceId Passed rather than read off the actor. Every caller has
 *   already resolved it through `requireWorkspaceId`, and reaching for a
 *   nullable field here would need a default that silently mis-files a row.
 */
export type ActivityRecorder = (
  db: Queryable,
  workspaceId: string,
  actor: Actor,
  draft: ActivityDraft,
) => Promise<void>

/**
 * The display name to show when no member is behind an action.
 *
 * A workspace key belongs to the workspace rather than to a person, so there is
 * no member row to name. Integrations set their own label here: `Form`, `Gmail`.
 */
const WORKSPACE_KEY_LABEL = 'API key'

export interface ActivityRecorderDependencies {
  readonly createId: IdFactory
  readonly now: () => Date
}

export function createActivityRecorder(
  dependencies: ActivityRecorderDependencies,
): ActivityRecorder {
  return async (db, workspaceId, actor, draft) => {
    const memberId = actorMemberId(actor)

    await repository.insertActivity(db, {
      id: dependencies.createId('activity'),
      workspaceId,
      targetType: draft.targetType,
      targetId: draft.targetId,
      kind: draft.kind,
      actorMemberId: memberId,
      actorLabel: memberId === null ? WORKSPACE_KEY_LABEL : null,
      action: draft.action,
      detail: draft.detail,
      createdAt: dependencies.now(),
    })
  }
}
