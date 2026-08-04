import { LIST_COLUMNS } from '@kelpie/schemas'
import type { ImportColumnMap, MatchKeyOption } from '@kelpie/schemas'

import { normaliseDomain, normaliseEmail } from '../../lib/normalisation.ts'

/**
 * Turning a CSV row into Kelpie values, and turning either a row or a stored
 * record into the string a match key compares on.
 *
 * One key builder serves both sides. A row and the record it might match have to
 * reduce to the same string or the match is a coin toss, and two builders in two
 * files is how they stop agreeing. Pure.
 */

/** Cents per major unit. The `value` column is dollars, not cents — see `moneyToCents`. */
const CENTS_PER_UNIT = 100

/**
 * Applies a column map to a source row.
 *
 * @returns Kelpie column → value, for the mapped columns only. An unmapped
 *   column is absent rather than `''`, so "the file has no such column" and "the
 *   file has one and this cell is empty" stay different facts.
 */
export function mapRow(
  values: Readonly<Record<string, string>>,
  columnMap: ImportColumnMap,
): Readonly<Record<string, string>> {
  const mapped: Record<string, string> = {}

  for (const [column, header] of Object.entries(columnMap)) {
    if (header === null) {
      continue
    }

    mapped[column] = values[header] ?? ''
  }

  return mapped
}

/** A pipe-separated cell (`a|b|c`), per `import-export.md`. Blank entries are dropped. */
export function splitList(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** Whether a Kelpie column carries a pipe-separated list. */
export function isListColumn(column: string): boolean {
  return LIST_COLUMNS.has(column)
}

/**
 * The normalised form of one match-key component.
 *
 * Emails and domains go through the same normalisation a write does, so a row
 * saying `HTTPS://Acme.com/` matches the company stored as `acme.com`. Names and
 * titles are compared case-insensitively, which is how a person reads them.
 * `external_id` is left alone: it is an opaque token from another system, and
 * two ids differing only in case are two ids.
 */
function normaliseComponent(column: string, value: string): string | null {
  if (column === 'email' || column === 'person_email' || column === 'owner_email') {
    return normaliseEmail(value)
  }

  if (column === 'domain' || column === 'company_domain') {
    return normaliseDomain(value)
  }

  if (column === 'external_id') {
    const trimmed = value.trim()

    return trimmed.length === 0 ? null : trimmed
  }

  const folded = value.trim().toLowerCase()

  return folded.length === 0 ? null : folded
}

/**
 * The values a match key is built from, by canonical column name.
 *
 * A mapped CSV row is already this shape. A stored record is reduced to it by
 * the repository, which is what lets both sides produce the same key.
 */
export type MatchKeyParts = Readonly<Record<string, string | null | undefined>>

/**
 * @returns The comparable key, or null when any component is missing or blank.
 *   Null means "this row cannot be matched", which is a row error rather than a
 *   silent match against everything else that is also missing that column.
 */
export function buildMatchKey(matchKey: MatchKeyOption, parts: MatchKeyParts): string | null {
  const components: string[] = []

  for (const column of matchKey.columns) {
    const raw = parts[column]

    if (raw === null || raw === undefined) {
      return null
    }

    const normalised = normaliseComponent(column, raw)

    if (normalised === null) {
      return null
    }

    components.push(normalised)
  }

  return `${matchKey.id}:${components.join('|')}`
}

/**
 * Reads the `value` column as integer cents.
 *
 * **The column is the major unit**, not cents: it is what a person types into a
 * spreadsheet and what HubSpot's `Amount` and Salesforce's `Amount` both carry.
 * An export writes the same way, so a Kelpie CSV round-trips. Getting this
 * backwards is a hundredfold error in every number, which is why it is one
 * function with one test rather than a conversion at each call site.
 *
 * Currency symbols and thousands separators are stripped: a spreadsheet
 * formatted as currency exports `$1,200.00`, and refusing that would fail rows
 * whose meaning is not in doubt.
 *
 * @returns undefined when the cell is not a number. Blank is `null`, meaning no
 *   value was given.
 */
export function moneyToCents(raw: string | undefined): number | null | undefined {
  const trimmed = (raw ?? '').trim()

  if (trimmed.length === 0) {
    return null
  }

  const stripped = trimmed.replace(/[$£€\s,]/gu, '')

  if (!/^-?\d+(\.\d+)?$/u.test(stripped)) {
    return undefined
  }

  return Math.round(Number(stripped) * CENTS_PER_UNIT)
}

/** Renders stored cents back into the major unit an export writes. */
export function centsToMoney(cents: number | null): string {
  return cents === null ? '' : (cents / CENTS_PER_UNIT).toFixed(2)
}
