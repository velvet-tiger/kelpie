import {
  addListMemberBody,
  listMemberSchema,
  listMembershipSchema,
} from '@kelpie/schemas'
import type {
  AddListMemberInput,
  ListMember,
  ListMembership,
  RecordTargetType,
} from '@kelpie/schemas'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'

import type { Page } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { usePagedList } from '../resource.ts'
import type { MutationResult, RecordListResult } from '../resource.ts'

/**
 * `/v1/lists/:id/members`. Nested per list, so the standard resource hook cannot
 * mint the path. Built by hand with the same read/write cache invalidation
 * pattern the other resources use.
 */

type MembersData = InfiniteData<Page<ListMember>, string | null>

function membersKey(listId: string): readonly unknown[] {
  return ['lists', 'members', listId]
}

function membershipsKey(targetType: string, targetId: string): readonly unknown[] {
  return ['lists', 'memberships', targetType, targetId]
}

/** The list-level entries whose cached counts change when a member is added or removed. */
function listsInvalidations(): readonly unknown[] {
  return ['lists', 'list']
}

export interface ListMembershipsResult {
  readonly memberships: readonly ListMembership[]
  readonly isLoading: boolean
  readonly error: Error | null
}

/**
 * "Which lists is this record on?"
 *
 * A plain `useQuery` rather than the paged read: the endpoint is not paged.
 * The invalidation key overlaps with `useListMembers` so adding or removing on
 * either side refreshes both views.
 */
export function useListMembershipsFor(
  targetType: RecordTargetType | undefined,
  targetId: string | undefined,
): ListMembershipsResult {
  const client = useApiClient()
  const enabled = targetType !== undefined && targetId !== undefined
  const result = useQuery({
    queryKey: membershipsKey(targetType ?? '', targetId ?? ''),
    queryFn: async () => {
      const page = await client.list(
        '/list-memberships',
        listMembershipSchema.parse,
        { target_type: targetType, target_id: targetId },
      )

      return page.items
    },
    enabled,
  })

  return {
    memberships: result.data ?? [],
    isLoading: result.isPending && enabled,
    error: toError(result.error),
  }
}

export function useListMembers(listId: string | undefined): RecordListResult<ListMember> {
  return usePagedList<ListMember>({
    queryKey: membersKey(listId ?? ''),
    path: `/lists/${listId ?? ''}/members`,
    decode: listMemberSchema.parse,
    query: {},
    enabled: listId !== undefined,
  })
}

export interface AddMemberArguments {
  readonly listId: string
  readonly input: AddListMemberInput
}

export function useAddListMember(): MutationResult<AddMemberArguments, ListMember> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ listId, input }: AddMemberArguments) =>
      client.post(`/lists/${listId}/members`, addListMemberBody(input), listMemberSchema.parse),
    onSettled: (_record, _error, { listId }) => {
      void queryClient.invalidateQueries({ queryKey: membersKey(listId) })
      void queryClient.invalidateQueries({ queryKey: listsInvalidations() })
      void queryClient.invalidateQueries({ queryKey: ['lists', 'memberships'] })
    },
  })

  return {
    run: (input) => {
      mutation.mutate(input)
    },
    runAsync: (input) => mutation.mutateAsync(input),
    isPending: mutation.isPending,
    error: toError(mutation.error),
  }
}

export interface RemoveMemberArguments {
  readonly listId: string
  readonly id: string
}

export function useRemoveListMember(): MutationResult<RemoveMemberArguments, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ listId, id }: RemoveMemberArguments) =>
      client.delete(`/lists/${listId}/members/${id}`),
    onMutate: async ({ listId, id }) => {
      await queryClient.cancelQueries({ queryKey: membersKey(listId) })
      const previous = queryClient.getQueryData<MembersData>(membersKey(listId))

      queryClient.setQueryData<MembersData>(membersKey(listId), (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            },
      )

      return { previous }
    },
    onError: (_error, { listId }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(membersKey(listId), context.previous)
      }
    },
    onSettled: (_record, _error, { listId }) => {
      void queryClient.invalidateQueries({ queryKey: membersKey(listId) })
      void queryClient.invalidateQueries({ queryKey: listsInvalidations() })
      void queryClient.invalidateQueries({ queryKey: ['lists', 'memberships'] })
    },
  })

  return {
    run: (input) => {
      mutation.mutate(input)
    },
    runAsync: (input) => mutation.mutateAsync(input),
    isPending: mutation.isPending,
    error: toError(mutation.error),
  }
}
