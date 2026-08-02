import { hash, verify } from '@node-rs/argon2'

/**
 * Password hashing. Argon2id, the parameters the library defaults to, which
 * follow the OWASP recommendation at time of writing.
 *
 * The algorithm and its parameters are embedded in the hash string, so raising
 * the cost later does not invalidate existing hashes: they verify with the
 * parameters they were made with, and `needsRehash` says when to upgrade one.
 */

/** Rejected before hashing. Argon2 will happily hash an empty string. */
const MINIMUM_LENGTH = 12

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
  if (plaintext.length < MINIMUM_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${MINIMUM_LENGTH} characters`)
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

export function isPasswordStrongEnough(plaintext: string): boolean {
  return plaintext.length >= MINIMUM_LENGTH
}

export const MINIMUM_PASSWORD_LENGTH = MINIMUM_LENGTH
