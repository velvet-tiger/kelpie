import { sql } from 'drizzle-orm'
import type { Column, SQL } from 'drizzle-orm'
import { check, customType, text, timestamp } from 'drizzle-orm/pg-core'
import type { PgColumn } from 'drizzle-orm/pg-core'

/**
 * Column conventions from `schema.md`, in one place so tables cannot drift.
 *
 * Primary keys are text `<prefix>_<ulid>` (see `lib/ids.ts`), not serials, so an
 * id is meaningful on its own and safe to expose.
 */

/**
 * Case-insensitive text, for emails and domains. Values are also normalised to
 * lowercase on write; citext makes a stray uppercase comparison still match
 * rather than silently creating a duplicate.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
})

export function primaryId() {
  return text('id').primaryKey()
}

/**
 * A Postgres full-text vector, for the `search_vector` column every searchable
 * table carries. Nothing selects it; it exists to be matched and ranked against.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
})

/**
 * The one text search configuration every vector and every query is built with.
 *
 * It has to be a literal rather than a setting: a generated column's expression
 * must be immutable, and `to_tsvector(text)` without an explicit configuration
 * reads `default_text_search_config` at run time, which makes it merely stable.
 * A per-workspace language would therefore need its own column, not a parameter.
 */
export const SEARCH_CONFIGURATION = 'english'

/**
 * Where a field sits in a result's ranking. `ts_rank` weighs A heaviest.
 *
 * A is what the reader clicks: a name, a title, the body of a decision. B is the
 * record's own prose. C is tags and other short arrays, which match usefully but
 * should not outrank a name.
 */
export type SearchWeight = 'A' | 'B' | 'C'

export interface SearchVectorPart {
  readonly column: Column
  readonly weight: SearchWeight
  /**
   * True for a `text[]` column. Arrays are flattened by
   * `kelpie_text_array_to_string`, a wrapper that migration `0015` adds because
   * `array_to_string` itself is stable rather than immutable and Postgres refuses
   * a generated column built on it.
   */
  readonly array?: boolean
}

/**
 * Every run of non-alphanumeric characters becomes a space before the text is
 * tokenised.
 *
 * **The vector has to be split the same way the query is**, and the query splits
 * on exactly this (`modules/search/query.ts`). Left alone, Postgres reads
 * `ada@analytical.test` as one `email` token and `acme.com` as one `host` token,
 * while a search for `analytical` arrives as the single word `analytical`. The two
 * never meet, and an address is findable only by typing its opening characters.
 *
 * Immutable, which a generated column requires: `regexp_replace` with constant
 * pattern and flags is marked `i` in `pg_proc`.
 */
const SPLIT_ON_PUNCTUATION = sql.raw("'[^[:alnum:]]+', ' ', 'g'")

function searchVectorPart(part: SearchVectorPart): SQL {
  const raw = part.array === true
    ? sql`coalesce(kelpie_text_array_to_string(${part.column}), '')`
    : sql`coalesce(${part.column}::text, '')`
  const source = sql`regexp_replace(${raw}, ${SPLIT_ON_PUNCTUATION})`

  return sql`setweight(to_tsvector(${sql.raw(`'${SEARCH_CONFIGURATION}'`)}, ${source}), ${sql.raw(`'${part.weight}'`)})`
}

/**
 * The `search_vector` column: a stored, generated tsvector over the record's own
 * text, indexed with GIN by the table that declares it.
 *
 * Generated rather than maintained by the service, so it cannot fall out of step
 * with the row. A trigger or an application write would both leave a window where
 * an updated record is unfindable, and an import that bypassed the service would
 * leave one permanently.
 *
 * The declared return type is not decoration. Every part names a column of the
 * table being declared, so an inferred one would send TypeScript around a cycle:
 * the table's type needs this column's type, which would need the parts, which
 * name the table. Naming the type up front cuts it, the same way Drizzle's own
 * self-referencing examples annotate their generated expressions.
 *
 * @param parts Deferred for the same reason at run time. Reading them eagerly
 *   would run before the table's own `const` is assigned.
 */
export function searchVector(parts: () => readonly SearchVectorPart[]): SearchVectorColumn {
  return tsvector('search_vector').generatedAlwaysAs((): SQL =>
    parts()
      .map(searchVectorPart)
      .reduce((left, right) => sql`${left} || ${right}`),
  )
}

type SearchVectorColumn = ReturnType<ReturnType<typeof tsvector>['generatedAlwaysAs']>

/**
 * Timestamps are `Date` in TypeScript, never strings. Postgres renders its own
 * string format (`2026-08-02 11:23:26.138+00`), which is not the ISO 8601 that
 * `api.md` requires, so string mode would leak a non-conforming value straight
 * onto the wire. Routes call `toISOString()` at the boundary.
 */
export function createdAt() {
  return timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
}

export function updatedAt() {
  return timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
}

/** A timestamptz that carries a real domain meaning rather than row bookkeeping. */
export function moment(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' })
}

/**
 * A check constraint restricting a column to a fixed set, built from the same
 * array the API validates against.
 *
 * `schema.md` stores fixed enums as text plus a check rather than as a Postgres
 * enum, so that adding a value is a constraint swap instead of a type migration.
 * The cost of that is two lists of the same values, one in the constraint and one
 * at the boundary. Taking both from one array is what stops them drifting into a
 * request the API accepts and the database rejects with a 500.
 *
 * @param values Literals from our own source, never request data. They are
 *   inlined into DDL, so a quote in one would be a syntax error at boot.
 */
export function checkOneOf(name: string, column: PgColumn, values: readonly string[]) {
  return check(name, oneOf(name, column, values))
}

/**
 * The `column in (…)` half of such a constraint, for a column whose rule needs
 * more than membership. A nullable enum is the case: `interview_stage` is either
 * null or one of the stages, and only the second half comes from the array.
 *
 * @param constraintName Only for the error below, which fires at boot.
 */
export function oneOf(constraintName: string, column: Column, values: readonly string[]) {
  const offending = values.find((value) => value.includes("'"))

  if (offending !== undefined) {
    throw new Error(
      `Check constraint ${constraintName} cannot inline a value containing a quote: ${offending}`,
    )
  }

  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`
}
