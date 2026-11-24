import { createListBody, listBody, listSchema, listStatsSchema } from '@kelpie/schemas'
import type { CreateListInput, List, ListInput, ListStats, RecordTargetType } from '@kelpie/schemas'
import { useQuery } from '@tanstack/react-query'

import type { QueryParameters } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/** `/v1/lists`. A list holds records of one type; the type is fixed at creation. */

const lists = createResourceHooks<List, CreateListInput, ListInput>({
  name: 'lists',
  path: '/lists',
  decode: listSchema.parse,
  createBody: createListBody,
  updateBody: listBody,
})

export interface ListFilters {
  readonly term?: string | undefined
  readonly targetType?: RecordTargetType | undefined
  readonly limit?: number | undefined
  readonly sort?: string | undefined
}

function listsQuery(filters: ListFilters): QueryParameters {
  return {
    q: filters.term,
    target_type: filters.targetType,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useLists(
  filters: ListFilters = {},
  options: ListOptions = {},
): RecordListResult<List> {
  return lists.useList(listsQuery(filters), options)
}

export function useList(id: string | undefined): RecordResult<List> {
  return lists.useRecord(id)
}

export function useCreateList(): MutationResult<CreateListInput, List> {
  return lists.useCreate()
}

export function useUpdateList(): MutationResult<UpdateArguments<ListInput>, List> {
  return lists.useUpdate()
}

export function useDeleteList(): MutationResult<string, void> {
  return lists.useRemove()
}

/**
 * The cache key for one list's stats. Exported so the member mutations in
 * `listMembers.ts` can refresh it when a record joins or leaves the list.
 */
export function listStatsKey(listId: string): readonly unknown[] {
  return ['lists', 'stats', listId]
}

export interface ListStatsState {
  readonly stats: ListStats | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

/** `GET /v1/lists/:id/stats`: totals over every member, not one page of them. */
export function useListStats(listId: string | undefined): ListStatsState {
  const client = useApiClient()
  const enabled = listId !== undefined
  const result = useQuery({
    queryKey: listStatsKey(listId ?? ''),
    queryFn: () => client.get(`/lists/${listId ?? ''}/stats`, listStatsSchema.parse),
    enabled,
  })

  return {
    stats: result.data,
    isLoading: result.isPending && enabled,
    error: toError(result.error),
  }
}
