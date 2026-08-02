import { generateToken, hashToken } from '../../lib/tokens.ts'

/**
 * Key formatting. The prefix is what a leak scanner greps for, so it stays in the
 * secret itself rather than only in the database.
 */

export const KEY_KINDS = ['workspace', 'personal'] as const

export type KeyKind = (typeof KEY_KINDS)[number]

/** `api.md` pins these strings; they appear in every customer's credential store. */
const SECRET_PREFIXES: Readonly<Record<KeyKind, string>> = {
  workspace: 'kp_live_',
  personal: 'kp_user_',
}

export interface MintedKey {
  /** Shown once, at creation, and never retrievable again. */
  readonly secret: string
  readonly secretHash: string
  /** Safe to store and display: prefix plus the last four characters. */
  readonly displayPrefix: string
}

export function parseKeyKind(value: string): KeyKind | undefined {
  return KEY_KINDS.find((kind) => kind === value)
}

/** The kind a secret claims to be, read from its prefix. */
export function kindOfSecret(secret: string): KeyKind | undefined {
  return KEY_KINDS.find((kind) => secret.startsWith(SECRET_PREFIXES[kind]))
}

export function mintKey(kind: KeyKind, randomToken: () => string = generateToken): MintedKey {
  const secret = `${SECRET_PREFIXES[kind]}${randomToken()}`

  return {
    secret,
    secretHash: hashToken(secret),
    displayPrefix: `${SECRET_PREFIXES[kind]}…${secret.slice(-4)}`,
  }
}

/**
 * Pulls the credential out of an `Authorization` header.
 *
 * @returns The bearer value, or undefined when the header is absent or not a
 *   bearer scheme. A malformed header is not an error here; the caller decides.
 */
export function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined
  }

  const match = /^Bearer\s+(?<token>\S+)$/iu.exec(header)

  return match?.groups?.token
}
