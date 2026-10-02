import { z } from 'zod'

/**
 * Wire shape for `GET /v1/tags`. Read-only, so there is no body builder.
 *
 * Tags are not records. They are strings in the `tags` array of each taggable
 * record, so this is a summary across those arrays rather than a collection:
 * one object, no cursor, and `?limit=` caps the list.
 */

export interface TagSuggestion {
  readonly tag: string
  /**
   * How many records carry the tag. Zero for a tag that only a Form will set,
   * through its `person_tags` or `company_tags`.
   */
  readonly count: number
}

export interface TagSuggestions {
  /** The `?q=` filter as sent, or null when the request named none. */
  readonly query: string | null
  readonly limit: number
  /** Most used first, then alphabetical. */
  readonly tags: readonly TagSuggestion[]
}

const suggestionSchema: z.ZodType<TagSuggestion, unknown> = z.object({
  tag: z.string(),
  count: z.number().int(),
})

export const tagSuggestionsSchema: z.ZodType<TagSuggestions, unknown> = z.object({
  query: z.string().nullable(),
  limit: z.number().int(),
  tags: z.array(suggestionSchema),
})
