import type { ApiKeyScope, EventActor, MemberRole } from '@kelpie/schemas'

import { AppError } from './errors.ts'

/**
 * Who is making a request. Resolved from credentials and passed explicitly to
 * services; nothing reads auth state from a global.
 *
 * A union rather than a bag of optional fields, so a handler that needs a signed-in
 * human cannot silently accept a workspace key that has no user behind it.
 *
 * It lives in `lib/` rather than in the auth module because the module runtime has
 * to name it: an MCP tool receives its caller the same way a route handler does
 * (`runtime/module.ts`), and `runtime/` must not import a feature module. Auth is
 * still where an actor is *resolved* (`modules/auth/credentials.ts`), and
 * `modules/auth/actor.ts` is still where modules read the type from.
 */

/** A browser session. `workspaceId` is null between signup and the first workspace. */
export interface SessionActor {
  readonly kind: 'session'
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly role: MemberRole | null
  /** The `workspace_members` row behind this actor. Null when there is no membership. */
  readonly memberId: string | null
}

/**
 * A bearer key, always bound to one workspace at creation.
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
  /** Empty means full access. Presets and granular tokens may be mixed. */
  readonly scopes: readonly ApiKeyScope[]
  /** Null for a workspace key: it belongs to the workspace, not to a member. */
  readonly memberId: string | null
}

/**
 * An OAuth grant: an MCP client the user approved for one workspace.
 *
 * It acts as its user in that workspace, as a personal key does, and its scopes
 * narrow what the user's role allows. It is its own kind rather than an
 * `ApiKeyActor` because a grant is not a key: logs, the audit trail and the
 * rate limiter must be able to tell them apart.
 *
 * Unlike a key, an empty `scopes` never means full access. A grant always
 * carries at least one scope, and `hasApiKeyScope` refuses an empty list.
 *
 * Accepted at `/mcp` only. `/v1` answers `401` to an OAuth token
 * (`modules/auth/credentials.ts`).
 */
export interface OAuthActor {
  readonly kind: 'oauth'
  readonly grantId: string
  readonly clientId: string
  readonly userId: string
  readonly workspaceId: string
  readonly role: MemberRole
  readonly scopes: readonly ApiKeyScope[]
  readonly memberId: string
}

export type Actor = SessionActor | ApiKeyActor | OAuthActor

/** A caller that presented a bearer credential rather than a session cookie. */
export type BearerActor = ApiKeyActor | OAuthActor

/**
 * True for an API key or an OAuth grant.
 *
 * Use this, not `actor.kind === 'api_key'`, wherever the rule is about bearer
 * credentials: scope checks, the per-credential rate limit, the workspace a
 * credential is bound to. A check written against `'api_key'` alone lets an
 * OAuth grant skip it.
 */
export function isBearerActor(actor: Actor): actor is BearerActor {
  return actor.kind === 'api_key' || actor.kind === 'oauth'
}

/** The id a bearer credential is counted and logged under: the key, or the grant. */
export function bearerCredentialId(actor: BearerActor): string {
  return actor.kind === 'api_key' ? actor.apiKeyId : actor.grantId
}

/** The workspace an actor is operating in, or null if a fresh account has none yet. */
export function actorWorkspaceId(actor: Actor): string | null {
  return actor.workspaceId
}

/**
 * The same thing, for the endpoints that cannot work without one.
 *
 * CRM routes carry no workspace path segment and read no workspace header: a key
 * is bound to its workspace at creation and a session carries its active one.
 * The only actor without a workspace is an account between signup and its first
 * workspace create.
 *
 * @throws AppError 403 when the actor has no workspace.
 */
export function requireWorkspaceId(actor: Actor): string {
  if (actor.workspaceId === null) {
    throw new AppError('forbidden', 'Create or join a workspace before using this endpoint')
  }

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
    throw new AppError('forbidden', 'This endpoint needs a signed-in user, not an API key or OAuth token')
  }

  return actor
}

/** The user behind the request, if there is one. A workspace key has none. */
export function actorUserId(actor: Actor): string | null {
  return actor.userId
}

/**
 * The member row to attribute a write to: a note's author, an activity's actor.
 *
 * Null means nobody on the team did this. A workspace key is the case that
 * reaches here today; an integration writing on the workspace's behalf is the
 * one the `actor_label` column exists for.
 */
export function actorMemberId(actor: Actor): string | null {
  return actor.memberId
}

/**
 * Maps the request actor to the actor stamped on domain events.
 *
 * A signed-in user becomes `user`. A workspace key (no user behind it) becomes
 * `system`, because the event was caused by the workspace itself rather than
 * any one person.
 */
export function toEventActor(actor: Actor): EventActor {
  if (actor.userId !== null) {
    return { kind: 'user', id: actor.userId }
  }
  return { kind: 'system' }
}
