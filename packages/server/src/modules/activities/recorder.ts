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
 * Something that acts on the workspace without being anybody in it.
 *
 * A public form submit is the case this exists for: the request carries no
 * credentials, so there is no `Actor` to resolve and no member to attribute the
 * row to, but the timeline still has to say where it came from. `kind` keeps it
 * a discriminated union with `Actor`, whose members are `session` and `api_key`.
 */
export interface SystemActor {
  readonly kind: 'system'
  /** What the timeline prints in place of a member's name: `Form`, `Gmail`. */
  readonly label: string
}

/** Who a timeline row is attributed to. */
export type ActivityAuthor = Actor | SystemActor

/**
 * @param workspaceId Passed rather than read off the author. Every caller has
 *   already resolved it — through `requireWorkspaceId`, or from a form's
 *   `publicKey` — and reaching for a nullable field here would need a default
 *   that silently mis-files a row.
 */
export type ActivityRecorder = (
  db: Queryable,
  workspaceId: string,
  author: ActivityAuthor,
  draft: ActivityDraft,
) => Promise<void>

/**
 * The display name to show for a workspace key.
 *
 * A workspace key belongs to the workspace rather than to a person, so there is
 * no member row to name. Anything else with no member behind it says so through
 * a `SystemActor` and its own label.
 */
const WORKSPACE_KEY_LABEL = 'API key'

export interface ActivityRecorderDependencies {
  readonly createId: IdFactory
  readonly now: () => Date
}

/** The member row and the fallback label, exactly one of which is set. */
function attribute(author: ActivityAuthor): {
  readonly memberId: string | null
  readonly label: string | null
} {
  if (author.kind === 'system') {
    return { memberId: null, label: author.label }
  }

  const memberId = actorMemberId(author)

  return { memberId, label: memberId === null ? WORKSPACE_KEY_LABEL : null }
}

export function createActivityRecorder(
  dependencies: ActivityRecorderDependencies,
): ActivityRecorder {
  return async (db, workspaceId, author, draft) => {
    const { memberId, label } = attribute(author)

    await repository.insertActivity(db, {
      id: dependencies.createId('activity'),
      workspaceId,
      targetType: draft.targetType,
      targetId: draft.targetId,
      kind: draft.kind,
      actorMemberId: memberId,
      actorLabel: label,
      action: draft.action,
      detail: draft.detail,
      createdAt: dependencies.now(),
    })
  }
}
