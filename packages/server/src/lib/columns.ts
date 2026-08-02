import { customType, text, timestamp } from 'drizzle-orm/pg-core'

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
