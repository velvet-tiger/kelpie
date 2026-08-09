import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'

import { ApiError } from './client.ts'
import type { Decoder, Page, QueryParameters } from './client.ts'
import { useApiClient } from './context.ts'
import { toError } from './errors.ts'

/**
 * The read and write hooks for one `/v1` collection.
 *
 * Every CRM resource is the same five operations over the same list envelope,
 * so they are built once here and configured per resource. A resource module
 * supplies its path, its decoder, and its two body builders; it writes no cache
 * handling of its own.
 *
 * Pages see the three result types below and never import from
 * `@tanstack/react-query` directly. That is deliberate: it keeps page code short
 * and leaves the cache library replaceable without touching a page.
 */

/** A list, one page at a time. Nothing is truncated in silence: `hasMore` says so. */
export interface RecordListResult<TRecord> {
  readonly records: readonly TRecord[]
  readonly isLoading: boolean
  readonly error: Error | null
  readonly hasMore: boolean
  readonly isLoadingMore: boolean
  readonly loadMore: () => void
}

export interface RecordResult<TRecord> {
  readonly record: TRecord | undefined
  readonly isLoading: boolean
  readonly error: Error | null
  /** The record is not in this workspace, which `api.md` makes indistinguishable from not existing. */
  readonly isNotFound: boolean
}

export interface MutationResult<TInput, TOutput> {
  /** Fire and forget. A failure lands in `error` rather than in an unhandled rejection. */
  readonly run: (input: TInput) => void
  /** Await the result, for a caller that navigates or chains on success. Rejects on failure. */
  readonly runAsync: (input: TInput) => Promise<TOutput>
  readonly isPending: boolean
  readonly error: Error | null
}

export interface UpdateArguments<TUpdateInput> {
  readonly id: string
  readonly changes: TUpdateInput
}

export interface PatchResult<TChanges> {
  /** Fire and forget, bound to one record's id. A failure lands in `error`. */
  readonly patch: (changes: TChanges) => void
  readonly error: Error | null
}

export interface ListOptions {
  /**
   * Set false to hold the request back. A list filtered by a set of ids has
   * nothing to ask until those ids are known, and asking with the filter omitted
   * would answer with every record instead of none.
   */
  readonly enabled?: boolean
}

export interface ResourceHooks<TRecord, TCreateInput, TUpdateInput>
  extends ReadOnlyResourceHooks<TRecord> {
  useCreate(): MutationResult<TCreateInput, TRecord>
  useUpdate(): MutationResult<UpdateArguments<TUpdateInput>, TRecord>
  useRemove(): MutationResult<string, void>
}

/** What a collection with no write verbs offers. Activities are the case: the table is append-only. */
export interface ReadOnlyResourceHooks<TRecord> {
  useList(query?: QueryParameters, options?: ListOptions): RecordListResult<TRecord>
  useRecord(id: string | undefined): RecordResult<TRecord>
}

export interface ReadOnlyResourceDefinition<TRecord> {
  /** Cache key root. The plural resource name, e.g. `activities`. */
  readonly name: string
  /** Path under the API base, e.g. `/activities`. */
  readonly path: string
  readonly decode: Decoder<TRecord>
}

export interface ResourceDefinition<TRecord, TCreateInput, TUpdateInput>
  extends ReadOnlyResourceDefinition<TRecord> {
  readonly createBody: (input: TCreateInput) => unknown
  readonly updateBody: (input: TUpdateInput) => unknown
  /**
   * Other resources whose cached lists a write here can invalidate.
   *
   * A join record is the case that needs it. `GET /v1/people?company_id=` is a
   * list of people, so creating a Position changes its contents without
   * touching a single person, and a company page that only refetched positions
   * would render the new row against a name it never fetched.
   */
  readonly alsoInvalidates?: readonly string[]
}

type ListData<TRecord> = InfiniteData<Page<TRecord>, string | null>

interface ResourceKeys {
  readonly all: readonly unknown[]
  readonly lists: readonly unknown[]
  list(query: QueryParameters): readonly unknown[]
  detail(id: string): readonly unknown[]
}

function keysFor(name: string): ResourceKeys {
  return {
    all: [name],
    lists: [name, 'list'],
    list: (query) => [name, 'list', query],
    detail: (id) => [name, 'detail', id],
  }
}

/**
 * Applies a partial update to a record.
 *
 * `undefined` means "not sent" and `null` means "clear this field", per
 * `api.md`, so an undefined value must leave the existing one alone rather than
 * overwrite it.
 */
function mergeDefined<TRecord extends object>(record: TRecord, changes: Partial<TRecord>): TRecord {
  const merged = { ...record }

  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) {
      Object.assign(merged, { [key]: value })
    }
  }

  return merged
}

/** Rewrites one record everywhere it is cached: its own entry, and every list page holding it. */
function writeRecordEverywhere<TRecord extends { readonly id: string }>(
  queryClient: QueryClient,
  keys: ResourceKeys,
  record: TRecord,
): void {
  queryClient.setQueryData(keys.detail(record.id), record)
  queryClient.setQueriesData<ListData<TRecord>>({ queryKey: keys.lists }, (data) =>
    data === undefined
      ? data
      : {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === record.id ? record : item)),
          })),
        },
  )
}

function removeRecordEverywhere<TRecord extends { readonly id: string }>(
  queryClient: QueryClient,
  keys: ResourceKeys,
  id: string,
): void {
  queryClient.removeQueries({ queryKey: keys.detail(id) })
  queryClient.setQueriesData<ListData<TRecord>>({ queryKey: keys.lists }, (data) =>
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
}

/**
 * The read half: `useList` and `useRecord`, and nothing that writes.
 *
 * Split out because a collection can be read-only. `createResourceHooks` builds
 * on this rather than repeating it, so both kinds of resource page, cache, and
 * report a 404 identically.
 */
export function createReadOnlyResourceHooks<TRecord>(
  definition: ReadOnlyResourceDefinition<TRecord>,
): ReadOnlyResourceHooks<TRecord> {
  const keys = keysFor(definition.name)

  function useList(query: QueryParameters = {}, options: ListOptions = {}): RecordListResult<TRecord> {
    const client = useApiClient()
    const enabled = options.enabled ?? true
    const result = useInfiniteQuery({
      queryKey: keys.list(query),
      queryFn: ({ pageParam }) =>
        client.list(definition.path, definition.decode, {
          ...query,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // Without this a keystroke in the filter box blanks the table while the
      // next query runs, which reads as "no results" for as long as it takes.
      placeholderData: keepPreviousData,
      enabled,
    })

    return {
      records: result.data?.pages.flatMap((page) => page.items) ?? [],
      // A disabled query stays pending forever, which is not the same as loading.
      isLoading: result.isPending && enabled,
      error: toError(result.error),
      hasMore: result.hasNextPage,
      isLoadingMore: result.isFetchingNextPage,
      loadMore: () => {
        void result.fetchNextPage()
      },
    }
  }

  function useRecord(id: string | undefined): RecordResult<TRecord> {
    const client = useApiClient()
    const result = useQuery({
      queryKey: keys.detail(id ?? ''),
      queryFn: () => client.get(`${definition.path}/${id ?? ''}`, definition.decode),
      enabled: id !== undefined,
    })

    return {
      record: result.data,
      isLoading: result.isPending && id !== undefined,
      error: toError(result.error),
      isNotFound: result.error instanceof ApiError && result.error.status === 404,
    }
  }

  return { useList, useRecord }
}

export function createResourceHooks<
  TRecord extends { readonly id: string },
  TCreateInput,
  TUpdateInput extends Partial<TRecord>,
>(
  definition: ResourceDefinition<TRecord, TCreateInput, TUpdateInput>,
): ResourceHooks<TRecord, TCreateInput, TUpdateInput> {
  const keys = keysFor(definition.name)
  const related = (definition.alsoInvalidates ?? []).map(keysFor)
  const { useList, useRecord } = createReadOnlyResourceHooks(definition)

  /**
   * Marks this resource's lists stale, and the related resources' with them.
   * Applied to every write rather than only to create and delete: a resource
   * that declares a relation has one, whichever verb reaches it.
   */
  function invalidateLists(queryClient: QueryClient): void {
    for (const target of [keys, ...related]) {
      void queryClient.invalidateQueries({ queryKey: target.lists })
    }
  }

  function useCreate(): MutationResult<TCreateInput, TRecord> {
    const client = useApiClient()
    const queryClient = useQueryClient()
    const mutation = useMutation({
      mutationFn: (input: TCreateInput) =>
        client.post(definition.path, definition.createBody(input), definition.decode),
      // No optimistic insert: the id comes from the server, and the caller
      // usually navigates straight to the new record. A placeholder id would be
      // a route to a record that does not exist yet.
      onSuccess: (record) => {
        queryClient.setQueryData(keys.detail(record.id), record)
      },
      onSettled: () => {
        invalidateLists(queryClient)
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

  function useUpdate(): MutationResult<UpdateArguments<TUpdateInput>, TRecord> {
    const client = useApiClient()
    const queryClient = useQueryClient()
    const mutation = useMutation({
      mutationFn: ({ id, changes }: UpdateArguments<TUpdateInput>) =>
        client.patch(`${definition.path}/${id}`, definition.updateBody(changes), definition.decode),

      // Inline editing is the whole interaction on a detail page, so the field
      // has to settle the moment it is committed. The snapshot is what makes
      // that safe: a rejected PATCH puts the old value back.
      onMutate: async ({ id, changes }) => {
        await queryClient.cancelQueries({ queryKey: keys.detail(id) })
        const previous = queryClient.getQueryData<TRecord>(keys.detail(id))

        if (previous !== undefined) {
          writeRecordEverywhere(queryClient, keys, mergeDefined(previous, changes))
        }

        return { previous }
      },

      onError: (_error, _arguments_, context) => {
        if (context?.previous !== undefined) {
          writeRecordEverywhere(queryClient, keys, context.previous)
        }
      },

      onSuccess: (record) => {
        writeRecordEverywhere(queryClient, keys, record)
      },

      onSettled: (_record, _error, { id }) => {
        void queryClient.invalidateQueries({ queryKey: keys.detail(id) })
        invalidateLists(queryClient)
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

  function useRemove(): MutationResult<string, void> {
    const client = useApiClient()
    const queryClient = useQueryClient()
    const mutation = useMutation({
      mutationFn: (id: string) => client.delete(`${definition.path}/${id}`),

      onMutate: async (id) => {
        await queryClient.cancelQueries({ queryKey: keys.all })
        const previous = queryClient.getQueryData<TRecord>(keys.detail(id))
        const previousLists = queryClient.getQueriesData<ListData<TRecord>>({ queryKey: keys.lists })

        removeRecordEverywhere<TRecord>(queryClient, keys, id)

        return { previous, previousLists }
      },

      onError: (_error, id, context) => {
        for (const [key, data] of context?.previousLists ?? []) {
          queryClient.setQueryData(key, data)
        }

        if (context?.previous !== undefined) {
          queryClient.setQueryData(keys.detail(id), context.previous)
        }
      },

      onSettled: () => {
        invalidateLists(queryClient)
      },
    })

    return {
      run: (id) => {
        mutation.mutate(id)
      },
      runAsync: (id) => mutation.mutateAsync(id),
      isPending: mutation.isPending,
      error: toError(mutation.error),
    }
  }

  return { useList, useRecord, useCreate, useUpdate, useRemove }
}

/**
 * Binds a resource's `useUpdate` hook to one record's id, for a detail page's
 * inline edits.
 *
 * Every detail page had its own three-line `use<X>Patch` doing exactly this,
 * and every one of them discarded `update.error`. `InlineEdit`'s `onChange` has
 * no return value to reject, so a failed `PATCH` — a duplicate email or domain,
 * a dropped connection — had nowhere left to surface: the field just reverted
 * to its old value with no explanation. Callers now get the error back and
 * decide where to show it.
 */
export function usePatch<TRecord extends { readonly id: string }, TChanges>(
  useUpdate: () => MutationResult<UpdateArguments<TChanges>, TRecord>,
  record: TRecord,
): PatchResult<TChanges> {
  const update = useUpdate()

  return {
    patch: (changes) => {
      update.run({ id: record.id, changes })
    },
    error: update.error,
  }
}
