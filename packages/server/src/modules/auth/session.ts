import { setCookie } from 'hono/cookie'
import type { Context } from 'hono'

import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { hashToken } from '../../lib/tokens.ts'
import { parseMemberRole } from '../workspace/roles.ts'
import type { Actor } from './actor.ts'
import * as repository from './repository.ts'

/**
 * The session cookie, and turning it into an `Actor`.
 *
 * `api.md`: the workspace is always implicit. It comes from the session, never
 * from a header, a path segment, or a request body.
 *
 * Handlers resolve the actor explicitly rather than reading it from a context
 * variable, so the type is checked at every use.
 */

export const SESSION_COOKIE = 'kelpie_session'

/** Thirty days, matching the session row's expiry. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export interface SessionCookieOptions {
  /** Only sent over HTTPS outside development. */
  readonly secure: boolean
}

export function writeSessionCookie(context: Context, token: string, options: SessionCookieOptions): void {
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: options.secure,
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })
}

export function clearSessionCookie(context: Context, options: SessionCookieOptions): void {
  setCookie(context, SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: options.secure,
    path: '/',
    maxAge: 0,
  })
}

export interface SessionResolverDependencies {
  readonly db: Database
  readonly now: () => Date
}

/**
 * Turns a session token into an actor.
 *
 * A session whose active workspace no longer has a membership resolves with a
 * null workspace rather than failing: losing access to one workspace must not
 * lock the account out of the product.
 *
 * @throws AppError 401 when the token is absent, unknown, or expired.
 */
export async function resolveActor(
  dependencies: SessionResolverDependencies,
  token: string | undefined,
): Promise<Actor> {
  if (token === undefined || token.length === 0) {
    throw AppError.unauthorized('Sign in to continue')
  }

  const session = await repository.findLiveSessionByTokenHash(
    dependencies.db,
    hashToken(token),
    dependencies.now(),
  )

  if (session === undefined) {
    throw AppError.unauthorized('Your session has expired')
  }

  if (session.activeWorkspaceId === null) {
    return { userId: session.userId, sessionId: session.id, workspaceId: null, role: null }
  }

  const membership = await repository.findMembership(
    dependencies.db,
    session.activeWorkspaceId,
    session.userId,
  )

  if (membership === undefined) {
    return { userId: session.userId, sessionId: session.id, workspaceId: null, role: null }
  }

  const role = parseMemberRole(membership.role)

  if (role === undefined) {
    throw new Error(
      `workspace_members.role holds "${membership.role}", which its check constraint forbids`,
    )
  }

  return {
    userId: session.userId,
    sessionId: session.id,
    workspaceId: membership.workspaceId,
    role,
  }
}
