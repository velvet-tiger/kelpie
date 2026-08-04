import { sql } from 'drizzle-orm'
import type { Column } from 'drizzle-orm'
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
