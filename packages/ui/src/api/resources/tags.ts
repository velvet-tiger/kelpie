import { tagSuggestionsSchema } from '@kelpie/schemas'
import type { TagSuggestion, TagTargetType } from '@kelpie/schemas'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'

/**
 * `/v1/tags`, read-only: the tags already in use on one record type.
 *
 * Not a `createResourceHooks` resource. A tag is not a record: it has no id and
 * no write of its own, and it changes when the record carrying it is saved.
 */

/** How many suggestions a tag picker shows. */
const SUGGESTION_LIMIT = 20

export interface TagSuggestionsState {
  readonly suggestions: readonly TagSuggestion[]
  readonly isLoading: boolean
  readonly error: Error | null
}

/**
 * @param term What was typed. Empty asks for the most used tags, which is what a
 *   picker shows on focus before anyone types.
 * @param enabled False until the picker opens, so a page of tag fields does not
 *   send a request for each one on load.
 */
export function useTagSuggestions(
  targetType: TagTargetType,
  term: string,
  enabled: boolean,
): TagSuggestionsState {
  const client = useApiClient()
  const trimmed = term.trim()

  const result = useQuery({
    queryKey: ['tags', targetType, trimmed],
    queryFn: () =>
      client.get('/tags', tagSuggestionsSchema.parse, {
        target_type: targetType,
        q: trimmed.length === 0 ? undefined : trimmed,
        limit: SUGGESTION_LIMIT,
      }),
    enabled,
    // Keeps the last answer on screen while the next keystroke's request runs,
    // so the list does not blink empty between letters.
    placeholderData: keepPreviousData,
  })

  return {
    suggestions: result.data?.tags ?? [],
    isLoading: result.isPending && enabled,
    error: toError(result.error),
  }
}

/**
 * Marks every tag suggestion stale. A picker calls this after it saves, so a tag
 * created on one record is offered on the next one at once rather than after
 * the 30-second stale time.
 */
export function useInvalidateTagSuggestions(): () => void {
  const queryClient = useQueryClient()

  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['tags'] })
  }, [queryClient])
}
