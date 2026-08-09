import { searchResultsSchema } from '@kelpie/schemas'
import type { SearchResults } from '@kelpie/schemas'
import { useQuery } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'

/**
 * `/v1/search`, read-only: nine collections in one request.
 *
 * Not a `createResourceHooks` resource, for the same reason the dashboard is not.
 * There is no collection to page, no id in a path, and no write.
 *
 * Nothing invalidates this key. Results are derived from records other pages own,
 * so listing the writes that could change one would mean naming most of the API.
 * A search is re-run by typing, which is a new key.
 */

/** How many results each group carries. The total beside each group stays exact. */
const GROUP_LIMIT = 10

export interface SearchState {
  readonly results: SearchResults | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

/**
 * @param term What was typed. An empty one asks nothing: the query is disabled
 *   rather than sent, because `?q=` is required and a blank one is a 422.
 */
export function useSearch(term: string): SearchState {
  const client = useApiClient()
  const trimmed = term.trim()
  const enabled = trimmed.length > 0

  const result = useQuery({
    queryKey: ['search', trimmed],
    queryFn: () => client.get('/search', searchResultsSchema.parse, { q: trimmed, limit: GROUP_LIMIT }),
    enabled,
  })

  return {
    results: result.data,
    // A disabled query stays pending forever, which is not the same as loading.
    isLoading: result.isPending && enabled,
    error: toError(result.error),
  }
}
