import { setCookie } from 'hono/cookie'
import type { Context } from 'hono'

/**
 * The session cookie. Turning credentials into an actor lives in
 * `credentials.ts`, which handles bearer keys too.
 *
 * The workspace is always implicit (`docs/agents/api-and-webhooks.md`). It
 * comes from the session or the key, never from a header, a path segment, or
 * a request body.
 */

export const SESSION_COOKIE = 'kelpie_session'

/**
 * The device and location shown on the Security page come from the request
 * itself.
 *
 * Here rather than in `routes.ts` because the external sign-in handler needs
 * the same description, and a session created by a module should look the same
 * on that page as one created by the login form.
 */
export function describeClient(context: Context): { device?: string; location?: string } {
  const userAgent = context.req.header('User-Agent')

  return userAgent === undefined ? {} : { device: userAgent }
}

/** Thirty days, matching the session row's expiry. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export interface SessionCookieOptions {
  /** Only sent over HTTPS outside development. */
  readonly secure: boolean
}

/** What is left of an existing session, for a cookie that carries its new token. */
export interface RemainingLifetime {
  readonly expiresAt: Date
  readonly now: Date
}

/**
 * Sets the session cookie. A new session gets the full thirty days. A session
 * whose token was rotated passes `remaining`, so the cookie ends when the row
 * does rather than thirty days after the rotation.
 */
export function writeSessionCookie(
  context: Context,
  token: string,
  options: SessionCookieOptions,
  remaining?: RemainingLifetime,
): void {
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: options.secure,
    path: '/',
    maxAge: remaining === undefined ? COOKIE_MAX_AGE_SECONDS : remainingSeconds(remaining),
  })
}

function remainingSeconds(remaining: RemainingLifetime): number {
  return Math.max(0, Math.floor((remaining.expiresAt.getTime() - remaining.now.getTime()) / 1000))
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
