/**
 * The check an address passes before Kelpie sends mail to it.
 *
 * A mail library reads a recipient string as a header, not as one address:
 * `a@x.example, b@y.example` is two recipients, `Name <a@x.example>` is a
 * display name and an address, and a line break starts a new header. An
 * address somebody outside typed must therefore be exactly one mailbox, with
 * none of the characters that give a header its structure. The same characters
 * are the ones that turn an address into markup when it is put into an HTML
 * body.
 *
 * Deliberately a refusal list rather than a list of permitted characters. An
 * internationalised local part or domain is a real address and passes. This
 * does not decide whether the mailbox exists; the verification email does.
 */

/** Longest address SMTP carries: a 256-octet path, less its angle brackets. */
const MAXIMUM_ADDRESS_LENGTH = 254

/** Longest local part, the text before the `@`. */
const MAXIMUM_LOCAL_PART_LENGTH = 64

/**
 * Characters that cannot be in a single address: list separators, the angle
 * brackets and quotation mark of the display-name form, comment and literal
 * brackets, the group colon, the backslash, and every space, line break,
 * control and invisible formatting character.
 */
const REFUSED_CHARACTERS = /[,;:<>"()[\]\\\p{Z}\p{C}]/u

/**
 * Whether `value` is exactly one mailbox address, `local@domain`, and nothing
 * else. The caller trims first: surrounding space is refused here too.
 */
export function isSingleEmailAddress(value: string): boolean {
  if (value.length > MAXIMUM_ADDRESS_LENGTH || REFUSED_CHARACTERS.test(value)) {
    return false
  }

  const parts = value.split('@')
  const [local, domain] = parts

  if (parts.length !== 2 || local === undefined || domain === undefined) {
    return false
  }

  if (local.length === 0 || local.length > MAXIMUM_LOCAL_PART_LENGTH) {
    return false
  }

  const labels = domain.split('.')

  // A domain is at least two labels, and none is empty: no leading, trailing
  // or doubled dot.
  return labels.length >= 2 && labels.every((label) => label.length > 0)
}

/** The sender a deployment's `EMAIL_FROM` names. */
export interface SenderAddress {
  /** The display name, when the value carries one. */
  readonly name: string | undefined
  readonly address: string
}

/** The `Name <address>` form: a name, then one address in angle brackets. */
const NAMED_SENDER = /^([^<>]*)<([^<>]*)>$/u

/**
 * Characters a display name cannot hold: the quotation mark and backslash of
 * the quoted form, and every line break, control and invisible formatting
 * character. A comma or a full stop is permitted; the sender passes the name
 * to its mail library apart from the address, and the library quotes it.
 */
const REFUSED_NAME_CHARACTERS = /["\\\p{C}\p{Zl}\p{Zp}]/u

/**
 * Reads the sender value a deployment sets in `EMAIL_FROM`. Two forms are
 * permitted: one address, `kelpie@example.com`, or a display name and one
 * address, `Kelpie <kelpie@example.com>`. The name can be in quotation marks,
 * `"Acme, Inc." <kelpie@example.com>`.
 *
 * @returns The parts, or `undefined` when the value is neither form.
 */
export function parseSenderAddress(value: string): SenderAddress | undefined {
  if (value !== value.trim()) {
    return undefined
  }

  if (isSingleEmailAddress(value)) {
    return { name: undefined, address: value }
  }

  const named = NAMED_SENDER.exec(value)
  const rawName = named?.[1]?.trim()
  const address = named?.[2]

  if (rawName === undefined || address === undefined || !isSingleEmailAddress(address)) {
    return undefined
  }

  const quoted = rawName.length >= 2 && rawName.startsWith('"') && rawName.endsWith('"')
  const name = quoted ? rawName.slice(1, -1).trim() : rawName

  if (name.length === 0 || REFUSED_NAME_CHARACTERS.test(name)) {
    return undefined
  }

  return { name, address }
}
