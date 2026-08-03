import { z } from 'zod'

/**
 * Pieces every resource schema in this package is built from.
 *
 * `api.md` puts `snake_case` on the wire and `camelCase` in TypeScript, and says
 * the mapping happens at the boundary. For a client, this package is that
 * boundary: each resource declares a schema over the wire shape and transforms
 * it into the record the UI holds, so no component ever reads a `snake_case`
 * key.
 */

/** An `id` from `api.md`: `<prefix>_<ulid>`. Only checked for non-emptiness. */
export const idSchema = z.string().min(1)

/** An ISO 8601 UTC timestamp, read as a `Date`. */
export const timestampSchema = z.iso.datetime().transform((value) => new Date(value))

/** A nullable timestamp: `null` on the wire stays `null`, it does not become an epoch. */
export const nullableTimestampSchema = z.iso
  .datetime()
  .nullable()
  .transform((value) => (value === null ? null : new Date(value)))

/**
 * Fields every CRM record carries. Spread into a resource's wire object rather
 * than merged after the transform, because a transformed schema can no longer
 * be extended.
 */
export const recordTimestamps = {
  created_at: timestampSchema,
  updated_at: timestampSchema,
}

/** What `recordTimestamps` becomes once parsed. */
export interface RecordTimestamps {
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Drops keys whose value is `undefined`.
 *
 * `PATCH` sends only what changed, and `null` clears a nullable field, so an
 * `undefined` in a request body would be indistinguishable from "clear this"
 * once `JSON.stringify` removed it. Building bodies through this makes the
 * omission deliberate instead of incidental.
 */
export function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}
