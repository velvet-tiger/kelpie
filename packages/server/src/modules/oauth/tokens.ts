import { createHash } from 'node:crypto'

import { generateToken, hashToken } from '../../lib/tokens.ts'

/**
 * OAuth secret formats and lifetimes.
 *
 * The prefixes follow `kp_live_` and `kp_user_`: a leak scanner can recognise
 * them, and the credential resolver can tell an access token from an API key
 * before it reaches the database.
 */

/** These strings are fixed; they end up in every client's token store. */
export const ACCESS_TOKEN_PREFIX = 'kp_oat_'
export const REFRESH_TOKEN_PREFIX = 'kp_ort_'
export const CLIENT_SECRET_PREFIX = 'kp_ocs_'

export const CODE_LIFETIME_MS = 60_000
export const ACCESS_TOKEN_LIFETIME_MS = 60 * 60_000
/** From the last use: each refresh issues a new refresh token with a fresh 30 days. */
export const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60_000
/** Long enough to sign in and read the consent page, short enough not to linger. */
export const REQUEST_LIFETIME_MS = 10 * 60_000

export interface MintedSecret {
  /** Returned to the client once. Nothing stores it. */
  readonly secret: string
  readonly hash: string
}

export function mintSecret(prefix: string, randomToken: () => string = generateToken): MintedSecret {
  const secret = `${prefix}${randomToken()}`

  return { secret, hash: hashToken(secret) }
}

/** A code carries no prefix: it passes through a browser address bar, not a config file. */
export function mintCode(randomToken: () => string = generateToken): MintedSecret {
  const secret = randomToken()

  return { secret, hash: hashToken(secret) }
}

export function isAccessToken(secret: string): boolean {
  return secret.startsWith(ACCESS_TOKEN_PREFIX)
}

/**
 * The S256 PKCE check (RFC 7636 §4.6): base64url of the SHA-256 of the
 * verifier must equal the challenge the authorize request carried.
 */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url')

  return computed === challenge
}

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
export function isValidVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/u.test(verifier)
}

/** A base64url SHA-256 is always 43 characters. */
export function isValidChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/u.test(challenge)
}
