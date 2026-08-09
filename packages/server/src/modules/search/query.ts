/**
 * Turning what someone typed into a `tsquery`, and lifting a readable fragment
 * out of what matched.
 *
 * Pure: no database, no actor, no clock. Both halves are the parts of search most
 * likely to be wrong in a way no integration test would notice, so both are unit
 * tested against their own cases.
 */

/**
 * How long a `?q=` may be before the boundary refuses it.
 *
 * Every word becomes a clause of an `&`-joined `tsquery`, so an unbounded string
 * is an unbounded query plan. Nobody searches a CRM with a paragraph.
 */
export const MAX_SEARCH_TERM_LENGTH = 200

/** Anything that is not a letter or a digit separates one word from the next. */
const SEPARATORS = /[^\p{L}\p{N}]+/gu

/**
 * The typed string as a `tsquery`, or null when it holds nothing to search for.
 *
 * Every word is a prefix clause. Someone typing `acm` into a search box is part
 * way through `acme` and expects to see it; `to_tsquery('acm')` alone finds
 * nothing, because full-text matches whole lexemes. Stemming still applies on top,
 * so `meetings` finds a record that says `meeting`.
 *
 * Words are joined with `&`: every word has to appear somewhere in the record.
 * `|` would rank a record matching one word of four alongside one matching all of
 * them, which reads as a search box that ignores what you typed.
 *
 * @returns null when the input holds no letters or digits at all, which is a
 *   query with no clauses rather than a syntax error to hand to Postgres.
 */
export function toTsQuery(raw: string): string | null {
  const words = raw.split(SEPARATORS).filter((word) => word.length > 0)

  if (words.length === 0) {
    return null
  }

  return words.map((word) => `${word}:*`).join(' & ')
}

/** The words `toTsQuery` searched for, which is what `snippet` centres on. */
export function searchWords(raw: string): readonly string[] {
  return raw.split(SEPARATORS).filter((word) => word.length > 0)
}

/** How much of the source text a snippet carries, either side of the match. */
const LEAD = 24
const TRAIL = 56

/** Markdown punctuation, which is noise once a page body is one line of preview. */
const MARKUP = /[#*`|[\]_>]/gu

function flatten(body: string): string {
  return body.replace(MARKUP, ' ').replace(/\s+/gu, ' ').trim()
}

/**
 * Finds the earliest position any search word appears at, case-insensitively.
 *
 * @returns -1 when none of them appear literally. That is not a contradiction of
 *   the match: the row matched a stemmed lexeme (`meeting` for `meetings`) or
 *   matched on a different field than the one being excerpted.
 */
function firstMatch(haystack: string, words: readonly string[]): number {
  const lowered = haystack.toLowerCase()

  return words
    .map((word) => lowered.indexOf(word.toLowerCase()))
    .filter((index) => index >= 0)
    .reduce((earliest, index) => (earliest < 0 ? index : Math.min(earliest, index)), -1)
}

/**
 * A one-line fragment of `body`, centred on the first search word it contains.
 *
 * Falls back to the opening of the text when no word appears literally, because a
 * result with no preview at all reads as a result with no content.
 *
 * @param body The record's own prose. Markdown is flattened first.
 * @param words What was searched for, from `searchWords`.
 */
export function snippet(body: string, words: readonly string[]): string {
  const plain = flatten(body)

  if (plain.length === 0) {
    return ''
  }

  const found = firstMatch(plain, words)

  if (found < 0) {
    return plain.length > LEAD + TRAIL ? `${plain.slice(0, LEAD + TRAIL)}…` : plain
  }

  const start = Math.max(0, found - LEAD)
  const end = Math.min(plain.length, found + TRAIL)

  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}
