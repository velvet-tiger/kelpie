import { randomBytes } from 'node:crypto'

import { MINIMUM_PASSWORD_LENGTH } from '@kelpie/schemas'
import { hash, verify } from '@node-rs/argon2'

/**
 * Password hashing. Argon2id, the parameters the library defaults to, which
 * follow the OWASP recommendation at time of writing.
 *
 * The algorithm and its parameters are embedded in the hash string, so raising
 * the cost later does not invalidate existing hashes: they verify with the
 * parameters they were made with, and `needsRehash` says when to upgrade one.
 */

/**
 * Rejected before hashing. Argon2 will happily hash an empty string.
 *
 * The number lives in `@kelpie/schemas` because the browser's change-password
 * form states the rule before submitting, and two copies would be two rules.
 * Re-exported here so callers keep reading it off the module that enforces it.
 */
export { MINIMUM_PASSWORD_LENGTH }

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeakPasswordError'
  }
}

/**
 * @throws WeakPasswordError when the password is too short to be worth hashing.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters`)
  }

  return hash(plaintext)
}

/**
 * Constant-time within argon2 itself. Returns false rather than throwing on a
 * malformed stored hash, because a corrupted row must not become a login bypass
 * or a 500 that distinguishes it from a wrong password.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext)
  } catch {
    // A hash argon2 cannot parse is not a match. The row is corrupt, not correct.
    return false
  }
}

/**
 * The hash of a random password that nobody knows, made one time when the
 * process starts. A login for an account that has no password hash is verified
 * against it, so that login does the same work as a login with a wrong
 * password: one verify and no hash.
 *
 * It is made here and not for each login. A hash for each login made an
 * unknown address take two argon2 operations and a known one take one, and
 * that difference showed which addresses have an account.
 */
const PLACEHOLDER_HASH: Promise<string> = hash(randomBytes(32).toString('base64url'))

/**
 * Verifies a login attempt, in the same time for an account with a password,
 * an account without one, and no account at all.
 *
 * @param storedHash The account's hash, or null or undefined when there is no
 *   account or the account has no password.
 * @returns False when there is no stored hash, whatever the password is. The
 *   placeholder is there for the time it takes, not as a credential.
 */
export async function verifyLoginPassword(
  storedHash: string | null | undefined,
  plaintext: string,
): Promise<boolean> {
  const matches = await verifyPassword(storedHash ?? (await PLACEHOLDER_HASH), plaintext)

  return storedHash !== null && storedHash !== undefined && matches
}

export function isPasswordStrongEnough(plaintext: string): boolean {
  return plaintext.length >= MINIMUM_PASSWORD_LENGTH
}
