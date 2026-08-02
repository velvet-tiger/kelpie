import { setCookie } from 'hono/cookie'
import type { Context } from 'hono'

/**
 * The session cookie. Turning credentials into an actor lives in
 * `credentials.ts`, which handles bearer keys too.
 *
 * `api.md`: the workspace is always implicit. It comes from the session or the
 * key, never from a header, a path segment, or a request body.
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
