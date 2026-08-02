import { AppError } from '../../lib/errors.ts'
import type { MemberRole } from '../workspace/roles.ts'

/**
 * Who is making a request. Resolved from credentials and passed explicitly to
 * services; nothing reads auth state from a global.
 *
 * A union rather than a bag of optional fields, so a handler that needs a signed-in
 * human cannot silently accept a workspace key that has no user behind it.
 */

/** A browser session. `workspaceId` is null between signup and the first workspace. */
export interface SessionActor {
  readonly kind: 'session'
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly role: MemberRole | null
}

/**
 * A bearer key, always bound to one workspace at creation (`api.md`).
 *
 * `userId` is set for a personal key, which acts as its user, and null for a
 * workspace key, which acts as the workspace itself.
 */
export interface ApiKeyActor {
  readonly kind: 'api_key'
  readonly apiKeyId: string
  readonly userId: string | null
  readonly workspaceId: string
  readonly role: MemberRole
}

export type Actor = SessionActor | ApiKeyActor

/** The workspace an actor is operating in, or null if a fresh account has none yet. */
export function actorWorkspaceId(actor: Actor): string | null {
  return actor.workspaceId
}

/**
 * Narrows to a signed-in human.
 *
 * @throws AppError 403 for a key, which has no session to manage and no password
 *   to change.
 */
export function requireSessionActor(actor: Actor): SessionActor {
  if (actor.kind !== 'session') {
    throw new AppError('forbidden', 'This endpoint needs a signed-in user, not an API key')
  }

  return actor
}

/** The user behind the request, if there is one. A workspace key has none. */
export function actorUserId(actor: Actor): string | null {
  return actor.userId
}
