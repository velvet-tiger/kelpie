/**
 * Values stored in a normalised form, per `schema.md`. The columns are `citext`
 * as a second line of defence, so a missed normalisation still compares
 * correctly rather than creating a duplicate.
 *
 * Blank normalises to null rather than to `''`. Both columns are unique within a
 * workspace, so a stored empty string would make the second record without an
 * address a 409.
 */

/** A scheme prefix: `https://`, `mailto:` and anything else shaped like one. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//u

export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()

  return email.length === 0 ? null : email
}

/**
 * Reduces a domain to its host: no scheme, no path, no trailing dot.
 *
 * Deliberately permissive. This normalises what was given; it does not decide
 * whether the domain resolves, and a CRM regularly holds a company whose site is
 * not up yet.
 */
export function normaliseDomain(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(SCHEME, '')
    .split('/')[0]
    ?.replace(/\.$/u, '')

  return host === undefined || host.length === 0 ? null : host
}
