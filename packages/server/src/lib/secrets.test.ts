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
