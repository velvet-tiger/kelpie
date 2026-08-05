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
  /** @throws SecretDecryptionError when the text is malformed, tampered with, or sealed under another key. */
  open(sealed: string): string
}

/**
 * The environment slice a module needs to build a cipher. Modules validate it
 * through `context.config`, so a missing or malformed key stops boot with the
 * module named rather than failing on the first delivery attempt.
 */
export const secretEncryptionConfigSchema = z.object({
  SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((value) => decodeKey(value) !== undefined, {
      message: `must be ${String(KEY_BYTES)} bytes of base64, e.g. from: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    }),
})

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
export function createSecretCipher(config: SecretEncryptionConfig): SecretCipher {
  const key = decodeKey(config.SECRET_ENCRYPTION_KEY)

  if (key === undefined) {
    throw new Error(`SECRET_ENCRYPTION_KEY must be ${String(KEY_BYTES)} bytes of base64`)
  }

  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

      return [
        FORMAT_VERSION,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.')
    },

    open(sealed) {
      const [version, rawIv, rawTag, rawCiphertext] = sealed.split('.')

      if (version !== FORMAT_VERSION || rawIv === undefined || rawTag === undefined || rawCiphertext === undefined) {
        throw new SecretDecryptionError('the stored value is not in the expected format')
      }

      const iv = Buffer.from(rawIv, 'base64url')
      const tag = Buffer.from(rawTag, 'base64url')

      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new SecretDecryptionError('the stored value has a malformed header')
      }

      const decipher = createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(tag)

      try {
        return Buffer.concat([
          decipher.update(Buffer.from(rawCiphertext, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch (error: unknown) {
        // GCM raises here when the tag does not match the ciphertext, which
        // means either the wrong key or a modified row. The two are
        // indistinguishable and both are operator problems, not caller ones.
        throw new SecretDecryptionError('it was sealed with a different key, or has been altered', {
          cause: error,
        })
      }
    },
  }
}
