import { createListBody, listBody, listSchema } from '@kelpie/schemas'
import type { CreateListInput, List, ListInput, RecordTargetType } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
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
