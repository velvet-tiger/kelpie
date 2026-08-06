import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { SecretDecryptionError, createSecretCipher, secretEncryptionConfigSchema } from './secrets.ts'

const key = randomBytes(32).toString('base64')
const otherKey = randomBytes(32).toString('base64')

describe('secretEncryptionConfigSchema', () => {
  it('accepts 32 bytes of base64', () => {
    expect(secretEncryptionConfigSchema.safeParse({ SECRET_ENCRYPTION_KEY: key }).success).toBe(true)
  })

  it('rejects a key of the wrong length', () => {
    const short = randomBytes(16).toString('base64')

    expect(secretEncryptionConfigSchema.safeParse({ SECRET_ENCRYPTION_KEY: short }).success).toBe(false)
  })

  /** 64 hex characters look like a 32-byte key and decode to 48. */
  it('rejects a hex key', () => {
    const hex = randomBytes(32).toString('hex')

    expect(secretEncryptionConfigSchema.safeParse({ SECRET_ENCRYPTION_KEY: hex }).success).toBe(false)
  })

  it('rejects a missing key', () => {
    expect(secretEncryptionConfigSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a previous key, and accepts its absence', () => {
    expect(
      secretEncryptionConfigSchema.safeParse({
        SECRET_ENCRYPTION_KEY: key,
        SECRET_ENCRYPTION_KEY_PREVIOUS: otherKey,
      }).success,
    ).toBe(true)
    expect(secretEncryptionConfigSchema.safeParse({ SECRET_ENCRYPTION_KEY: key }).success).toBe(true)
  })

  /**
   * Ending a rotation means emptying the line far more often than deleting it,
   * and refusing to boot over that would punish the tidy step of the procedure.
   */
  it('treats a blank previous key as absent rather than malformed', () => {
    expect(
      secretEncryptionConfigSchema.safeParse({
        SECRET_ENCRYPTION_KEY: key,
        SECRET_ENCRYPTION_KEY_PREVIOUS: '',
      }).success,
    ).toBe(true)
  })

  /** A typo is not the same as an empty line, and must not be read as one. */
  it('rejects a previous key of the wrong length', () => {
    expect(
      secretEncryptionConfigSchema.safeParse({
        SECRET_ENCRYPTION_KEY: key,
        SECRET_ENCRYPTION_KEY_PREVIOUS: randomBytes(16).toString('base64'),
      }).success,
    ).toBe(false)
  })
})

describe('createSecretCipher', () => {
  const cipher = createSecretCipher({ SECRET_ENCRYPTION_KEY: key })

  it('reads back what it sealed', () => {
    expect(cipher.open(cipher.seal('whsec_abc123'))).toBe('whsec_abc123')
  })

  it('handles an empty string and multi-byte text', () => {
    expect(cipher.open(cipher.seal(''))).toBe('')
    expect(cipher.open(cipher.seal('secret — ünïcode 🐙'))).toBe('secret — ünïcode 🐙')
  })

  /** A reused IV would leak the relationship between two identical secrets. */
  it('produces different ciphertext for the same plaintext', () => {
    expect(cipher.seal('same')).not.toBe(cipher.seal('same'))
  })

  it('marks the format so a later scheme can be told apart', () => {
    expect(cipher.seal('x').startsWith('v1.')).toBe(true)
  })

  it('refuses text sealed under another key', () => {
    const sealed = createSecretCipher({ SECRET_ENCRYPTION_KEY: otherKey }).seal('whsec_abc123')

    expect(() => cipher.open(sealed)).toThrow(SecretDecryptionError)
  })

  it('refuses a tampered ciphertext rather than returning noise', () => {
    const [version, iv, tag] = cipher.seal('whsec_abc123').split('.')
    const forged = [version, iv, tag, Buffer.from('whsec_zzz').toString('base64url')].join('.')

    expect(() => cipher.open(forged)).toThrow(SecretDecryptionError)
  })

  it('refuses a malformed value', () => {
    expect(() => cipher.open('not-sealed')).toThrow(SecretDecryptionError)
    expect(() => cipher.open('v2.a.b.c')).toThrow(SecretDecryptionError)
    expect(() => cipher.open('v1.short.short.short')).toThrow(SecretDecryptionError)
  })
})

/**
 * Rotating `SECRET_ENCRYPTION_KEY` used to make every stored secret unreadable
 * with no way back. These are the two halves of the way out: the service keeps
 * working while both keys are configured, and `reseal` says which rows still
 * need rewriting.
 */
describe('rotating the key', () => {
  const third = randomBytes(32).toString('base64')
  /** What the service runs as mid-rotation: new key current, old key still held. */
  const rotating = createSecretCipher({
    SECRET_ENCRYPTION_KEY: key,
    SECRET_ENCRYPTION_KEY_PREVIOUS: otherKey,
  })
  const sealedUnderOld = createSecretCipher({ SECRET_ENCRYPTION_KEY: otherKey }).seal('whsec_old')

  it('opens a value sealed under the previous key', () => {
    expect(rotating.open(sealedUnderOld)).toBe('whsec_old')
  })

  it('seals new values under the current key, not the previous one', () => {
    const fresh = rotating.seal('whsec_new')

    expect(createSecretCipher({ SECRET_ENCRYPTION_KEY: key }).open(fresh)).toBe('whsec_new')
    expect(() => createSecretCipher({ SECRET_ENCRYPTION_KEY: otherKey }).open(fresh)).toThrow(
      SecretDecryptionError,
    )
  })

  it('re-seals a value from the previous key, preserving the plaintext', () => {
    const resealed = rotating.reseal(sealedUnderOld)

    expect(resealed).toBeTypeOf('string')
    // The point of the whole exercise: readable under the current key alone,
    // so the previous one can be removed from the environment.
    expect(createSecretCipher({ SECRET_ENCRYPTION_KEY: key }).open(resealed ?? '')).toBe('whsec_old')
  })

  /** What makes the pass idempotent: a second run must write nothing. */
  it('reports nothing to do for a value already under the current key', () => {
    expect(rotating.reseal(rotating.seal('whsec_new'))).toBeUndefined()
  })

  it('refuses a value sealed under neither key', () => {
    const stranger = createSecretCipher({ SECRET_ENCRYPTION_KEY: third }).seal('whsec_lost')

    expect(() => rotating.open(stranger)).toThrow(SecretDecryptionError)
    expect(() => rotating.reseal(stranger)).toThrow(SecretDecryptionError)
  })

  it('says which keys were tried, so an operator knows what to look for', () => {
    const stranger = createSecretCipher({ SECRET_ENCRYPTION_KEY: third }).seal('whsec_lost')

    expect(() => rotating.open(stranger)).toThrow(/neither the current nor the previous key/u)
    expect(() => createSecretCipher({ SECRET_ENCRYPTION_KEY: key }).open(stranger)).toThrow(
      /sealed with a different key/u,
    )
  })

  it('is a no-op with no previous key configured', () => {
    const settled = createSecretCipher({ SECRET_ENCRYPTION_KEY: key })

    expect(settled.reseal(settled.seal('whsec_new'))).toBeUndefined()
    expect(() => settled.reseal(sealedUnderOld)).toThrow(SecretDecryptionError)
  })
})
