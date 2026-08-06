import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'

/**
 * Reversible storage for secrets the service itself has to use again.
 *
 * Distinct from `lib/tokens.ts`, and the difference is what a secret is *for*.
 * A session cookie or an API key is only ever compared against, so it is stored
 * as a SHA-256 hash and nothing can read it back. A webhook signing secret is
 * different: `api.md` computes the delivery signature *with* it, and the
 * receiver holds the plaintext we showed them once, so the service must be able
 * to produce the same bytes months later. Hashing it would make signing
 * impossible; storing it bare would put every workspace's signing secret in any
 * database dump.
 *
 * `schema.md` already anticipates this for `agent_registrations.auth_header_encrypted`,
 * and `modules.md` for integration connection records. They share this module.
 */

/** AES-256-GCM: authenticated, so a tampered ciphertext fails rather than decodes to noise. */
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
/** 96 bits, the size GCM is specified for. A fresh one per seal, never reused. */
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Marks the format so a future scheme can be introduced without guessing at
 * what an existing row holds. Rotation reads the version, not the length.
 */
const FORMAT_VERSION = 'v1'

/** Thrown when sealed text cannot be read back: wrong key, or tampered ciphertext. */
export class SecretDecryptionError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`Could not decrypt a stored secret: ${reason}`)
    this.name = 'SecretDecryptionError'

    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

export interface SecretCipher {
  /** @returns `v1.<base64url iv>.<base64url tag>.<base64url ciphertext>`, safe to store as text. */
  seal(plaintext: string): string
  /**
   * Reads a stored value, trying the current key and then the previous one.
   *
   * @throws SecretDecryptionError when the text is malformed, tampered with, or
   *   sealed under a key this cipher does not hold.
   */
  open(sealed: string): string
  /**
   * The same value sealed under the current key, or undefined when it already is.
   *
   * This is what makes a re-seal pass idempotent: it is the only way to tell
   * "readable because it is current" from "readable because the previous key is
   * still configured", which `open` deliberately hides from everything else.
   *
   * @throws SecretDecryptionError when neither key opens it.
   */
  reseal(sealed: string): string | undefined
}

const KEY_MESSAGE = `must be ${String(KEY_BYTES)} bytes of base64, e.g. from: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

/**
 * The environment slice a module needs to build a cipher. Modules validate it
 * through `context.config`, so a missing or malformed key stops boot with the
 * module named rather than failing on the first delivery attempt.
 */
export const secretEncryptionConfigSchema = z.object({
  SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((value) => decodeKey(value) !== undefined, { message: KEY_MESSAGE }),

  /**
   * The key being rotated away from. Optional, and only set while a rotation is
   * in progress: `open` falls back to it, so the service keeps signing
   * deliveries between the moment the new key is deployed and the moment
   * `npm run reseal` finishes. Remove it once that pass reports nothing left.
   *
   * Blank counts as absent. An operator ending a rotation empties the line far
   * more often than they delete it, and refusing to boot over that would punish
   * the tidy step of the procedure.
   */
  SECRET_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .refine((value) => isBlank(value) || decodeKey(value) !== undefined, { message: KEY_MESSAGE })
    .optional(),
})

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

export type SecretEncryptionConfig = z.infer<typeof secretEncryptionConfigSchema>

/** @returns The key bytes, or undefined when the value is not base64 of exactly `KEY_BYTES`. */
function decodeKey(value: string): Buffer | undefined {
  // Buffer.from is lenient: it ignores what it cannot decode rather than
  // throwing, so the length check is the whole validation. A 64-character hex
  // key decodes to 48 bytes and is rejected here rather than silently truncated.
  const decoded = Buffer.from(value, 'base64')

  return decoded.length === KEY_BYTES ? decoded : undefined
}

/**
 * Builds the cipher from validated configuration.
 *
 * @throws Error when the key is not `KEY_BYTES` of base64. Unreachable through
 *   `secretEncryptionConfigSchema`, which rejects it at boot first.
 */
/** A stored value split into its parts, before any key has been tried. */
interface SealedParts {
  readonly iv: Buffer
  readonly tag: Buffer
  readonly ciphertext: Buffer
}

/** @throws SecretDecryptionError when the text is not a `v1` sealed value. */
function parseSealed(sealed: string): SealedParts {
  const [version, rawIv, rawTag, rawCiphertext] = sealed.split('.')

  if (version !== FORMAT_VERSION || rawIv === undefined || rawTag === undefined || rawCiphertext === undefined) {
    throw new SecretDecryptionError('the stored value is not in the expected format')
  }

  const iv = Buffer.from(rawIv, 'base64url')
  const tag = Buffer.from(rawTag, 'base64url')

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretDecryptionError('the stored value has a malformed header')
  }

  return { iv, tag, ciphertext: Buffer.from(rawCiphertext, 'base64url') }
}

/** @returns The plaintext, or undefined when this key is not the one it was sealed with. */
function openWith(key: Buffer, parts: SealedParts): string | undefined {
  const decipher = createDecipheriv(ALGORITHM, key, parts.iv)
  decipher.setAuthTag(parts.tag)

  try {
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // GCM raises here when the tag does not match, which means either the wrong
    // key or a modified row. Undefined rather than a throw because the caller is
    // working through a list of keys and a miss is expected on all but one.
    return undefined
  }
}

/** @throws Error when the value is not `KEY_BYTES` of base64. */
function requireKey(name: string, value: string): Buffer {
  const key = decodeKey(value)

  if (key === undefined) {
    throw new Error(`${name} must be ${String(KEY_BYTES)} bytes of base64`)
  }

  return key
}

export function createSecretCipher(config: SecretEncryptionConfig): SecretCipher {
  const current = requireKey('SECRET_ENCRYPTION_KEY', config.SECRET_ENCRYPTION_KEY)
  const previousValue = config.SECRET_ENCRYPTION_KEY_PREVIOUS

  // Blank counts as absent, which is how an operator normally ends a rotation.
  const previous =
    previousValue === undefined || isBlank(previousValue)
      ? undefined
      : requireKey('SECRET_ENCRYPTION_KEY_PREVIOUS', previousValue)

  /** Current first: the common case is a value that needs no fallback at all. */
  const keys = previous === undefined ? [current] : [current, previous]

  function seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, current, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

    return [
      FORMAT_VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.')
  }

  function open(sealed: string): string {
    const parts = parseSealed(sealed)

    for (const key of keys) {
      const plaintext = openWith(key, parts)

      if (plaintext !== undefined) {
        return plaintext
      }
    }

    throw new SecretDecryptionError(
      previous === undefined
        ? 'it was sealed with a different key, or has been altered'
        : 'neither the current nor the previous key opens it, or it has been altered',
    )
  }

  function reseal(sealed: string): string | undefined {
    if (openWith(current, parseSealed(sealed)) !== undefined) {
      return undefined
    }

    // Not readable under the current key, so `open` either finds it under the
    // previous one or throws, which is exactly the caller's answer either way.
    return seal(open(sealed))
  }

  return { seal, open, reseal }
}
