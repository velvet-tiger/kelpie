import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Bearer secrets: session cookies, password reset links, invite links, API keys.
 *
 * These are high-entropy random strings, not passwords, so SHA-256 is the right
 * store. A slow KDF here would buy nothing: there is no dictionary to attack.
 * Passwords use argon2 (`lib/passwords.ts`); the two must not be confused.
 */

/** 256 bits. Long enough that guessing is not a threat model. */
const TOKEN_BYTES = 32

export function generateToken(randomSource: (size: number) => Buffer = randomBytes): string {
  return randomSource(TOKEN_BYTES).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Compares two token hashes without leaking their difference through timing.
 *
 * Lookups are by hash, so this is for the cases that compare a stored hash to a
 * freshly computed one rather than querying by it.
 */
export function tokenHashesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')

  if (leftBytes.length !== rightBytes.length) {
    return false
  }

  return timingSafeEqual(leftBytes, rightBytes)
}
