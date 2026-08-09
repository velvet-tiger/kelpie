import { z } from 'zod'

import { SEARCH_COLLECTIONS } from './values.ts'
import type { SearchCollection } from './values.ts'
import { idSchema } from './wire.ts'

/**
 * Wire shape for `GET /v1/search`. Read-only, so there is no body builder.
 *
 * One object rather than a list envelope, and no cursor. Nine collections are
 * ranked separately, because a `ts_rank` over a handbook page and one over a
 * three-word Role title are not comparable numbers, and "which Deal" and "which
 * handbook page" are different questions anyway.
 *
 * Every group carries `total`, the count of every match, beside `items`, which
 * holds however many the request's `?limit=` allowed.
 */

export interface SearchResult {
  readonly id: string
  readonly title: string
  /**
   * The record's one line of context, already resolved. What it holds depends on
   * the collection: an email for a Person, a domain for a Company, the stage
   * label for a Deal or Raise, the kind for an Opportunity or Partnership, the
   * status for a Role, the slug for a handbook page, and the date decided for a
   * Decision as `YYYY-MM-DD`.
   */
  readonly subtitle: string | null
  /** A fragment of the record's prose centred on the match. Empty when it has none. */
  readonly snippet: string
}

export interface SearchResultGroup {
  readonly collection: SearchCollection
  readonly total: number
  readonly items: readonly SearchResult[]
}

export interface SearchResults {
  readonly query: string
  readonly limit: number
  /** Across every group, which is what a "12 results" heading is built from. */
  readonly total: number
  readonly groups: readonly SearchResultGroup[]
}

const resultSchema: z.ZodType<SearchResult, unknown> = z
  .object({
    id: idSchema,
    title: z.string(),
    subtitle: z.string().nullable(),
    snippet: z.string(),
  })
  .transform((wire) => ({
    id: wire.id,
    title: wire.title,
    subtitle: wire.subtitle,
    snippet: wire.snippet,
  }))

const groupSchema: z.ZodType<SearchResultGroup, unknown> = z
  .object({
    type: z.enum(SEARCH_COLLECTIONS),
    total: z.number().int(),
    items: z.array(resultSchema),
  })
  .transform((wire) => ({
    collection: wire.type,
    total: wire.total,
    items: wire.items,
  }))

export const searchResultsSchema: z.ZodType<SearchResults, unknown> = z
  .object({
    query: z.string(),
    limit: z.number().int(),
    total: z.number().int(),
    groups: z.array(groupSchema),
  })
  .transform((wire) => ({
    query: wire.query,
    limit: wire.limit,
    total: wire.total,
    groups: wire.groups,
  }))
