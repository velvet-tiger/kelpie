import { sql } from 'drizzle-orm'
import type { Column, SQL } from 'drizzle-orm'

/**
 * The `?q=` free-text filter from `api.md`: a case-insensitive substring match
 * over the fields the mockup's `FilterBar` matches for that object.
 *
 * Substring matching, not full-text search. A user typing three characters into a
 * filter box expects to see partial words, which `to_tsquery` will not give them.
 * Search across resources is its own feature with its own index.
 */

/** `%`, `_` and `\` steer LIKE. A user typing one means the character, not the pattern. */
const LIKE_WILDCARDS = /[\\%_]/gu

/** Wraps a search term as a LIKE pattern, escaping anything the user did not mean as a wildcard. */
export function containsPattern(term: string): string {
  return `%${term.trim().replace(LIKE_WILDCARDS, (match) => `\\${match}`)}%`
}

/**
 * True when any element of a `text[]` column matches the pattern.
 *
 * `tags @> '{…}'` would only find whole-tag equality, and the filter box is a
 * substring filter.
 */
export function arrayContainsPattern(column: Column, pattern: string): SQL {
  return sql`exists (select 1 from unnest(${column}) as element where element ilike ${pattern})`
}
